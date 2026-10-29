#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
asr.py - 本机离线语音识别（多后端）

后端：
  * whisper    : faster-whisper / CTranslate2（默认，逐词时间轴）
  * paraformer : FunASR Paraformer-Large（中文 CER 约 4.5%，句级时间戳）
  * sensevoice : FunASR SenseVoice-Small（中文 CER 约 7.8%，CPU 极快，内置标点+多语种）

用法：
  python scripts/asr.py --input 视频或音频 [更多文件...] --model 模型目录 --out 结果.json
                        [--backend whisper|paraformer|sensevoice]
                        [--lang zh] [--ffmpeg ffmpeg路径] [--prompt 提示语] [--beam 5]
  批量：多个 --input 时模型只加载一次，逐个推理；输出 {"batch":true,"results":[...]}，
        与输入顺序一一对应；单个文件失败不影响整批。

说明：
  * 不联网：模型目录由 --model 指定（本机已下载好的模型）。
  * 音频解码交给 FFmpeg（本工程自带 bin/ffmpeg.exe），再以 numpy/WAV 送入模型。
  * 输出：JSON，含分段、时间轴，供同步字幕与 SRT 使用。FunASR 后端输出结构与
    whisper 后端保持一致（segments[].start/end/text/words，置信度字段给安全默认），
    以便上层（幻觉过滤、字幕断句、SRT）无需改动即可复用。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np


def log(msg):
    # 进度/日志走 stderr，stdout 保持干净（便于调用方只解析最后一行 JSON）
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


def extract_wav(ffmpeg_path, src, out_wav, sr=16000):
    """用 FFmpeg 抽成 16kHz 单声道 16bit PCM WAV（模型标准输入）"""
    cmd = [
        ffmpeg_path, '-y', '-hide_banner', '-loglevel', 'error',
        '-i', src,
        '-vn', '-ac', '1', '-ar', str(sr), '-c:a', 'pcm_s16le',
        '-f', 'wav', out_wav,
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0 or not os.path.exists(out_wav) or os.path.getsize(out_wav) < 1000:
        raise RuntimeError('FFmpeg 抽音失败: ' + (p.stderr or b'').decode('utf-8', 'ignore')[-400:])
    return out_wav


def read_wav(path):
    """stdlib 读取 PCM WAV -> float32 [-1,1]（无需 soundfile）"""
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        raw = w.readframes(n)
        channels = w.getnchannels()
        if w.getsampwidth() != 2:
            raise RuntimeError('仅支持 16bit PCM WAV')
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data


def fmt2(x):
    return None if x is None else round(float(x), 2)


# ===== whisper 后端 =====
def build_whisper(args):
    from faster_whisper import WhisperModel
    return WhisperModel(
        args.model,
        device='cpu',
        compute_type=args.compute,
        cpu_threads=args.threads,
    )


def run_whisper(model, audio, args, duration):
    lang = None if args.lang in ('', 'auto') else args.lang
    kwargs = dict(
        beam_size=args.beam,
        word_timestamps=True,
        vad_filter=(args.vad == '1'),
        condition_on_previous_text=False,
    )
    if lang:
        kwargs['language'] = lang
    if args.prompt:
        kwargs['initial_prompt'] = args.prompt
    if args.vad == '1':
        kwargs['vad_parameters'] = dict(min_silence_duration_ms=250, speech_pad_ms=120)

    segments, info = model.transcribe(audio, **kwargs)

    out_segs = []
    last_emit = 0
    for s in segments:
        words = []
        for w in (getattr(s, 'words', None) or []):
            words.append({
                'w': w.word,
                's': fmt2(getattr(w, 'start', None)),
                'e': fmt2(getattr(w, 'end', None)),
                'p': round(float(getattr(w, 'probability', 0) or 0), 2),
            })
        out_segs.append({
            'start': fmt2(s.start),
            'end': fmt2(s.end),
            'text': (s.text or '').strip(),
            'words': words,
            'no_speech_prob': round(float(getattr(s, 'no_speech_prob', 0) or 0), 3),
            'avg_logprob': round(float(getattr(s, 'avg_logprob', 0) or 0), 3),
            'compression_ratio': round(float(getattr(s, 'compression_ratio', 0) or 0), 3),
        })
        now = time.time()
        if duration > 0 and now - last_emit > 0.4:
            last_emit = now
            pct = min(0.95, (s.end or 0) / duration)
            log('PROGRESS %.2f' % pct)
    return out_segs, {
        'engine': 'faster-whisper',
        'model': os.path.basename(os.path.normpath(args.model)),
        'computeType': args.compute,
        'language': getattr(info, 'language', None),
        'languageProbability': round(float(getattr(info, 'language_probability', 0) or 0), 3),
    }


# ===== FunASR 后端（paraformer / sensevoice）=====
# 可信度字段对 FunASR 没有原生输出，给安全默认值（均通过上层幻觉过滤）：
#   no_speech_prob=0, avg_logprob=0, compression_ratio=1
# 音乐幻觉改用 VAD 语音占比判断：语音不足则整段不输出字幕。
_SAFE_CONF = {'no_speech_prob': 0.0, 'avg_logprob': 0.0, 'compression_ratio': 1.0}
# SenseVoice 会在文本前后带 <|zh|> <|NEUTRAL|> 等标记，去掉
_TAG_RE = re.compile(r'<\|[^|]+\|>')


def _strip_sensevoice_tags(text):
    return _TAG_RE.sub('', text or '').strip()


# 把一句（VAD 合并后的连续语音）按标点切成子句，按时长比例分配时间，得到多条字幕。
# 中文短视频字幕常用做法：先保证文本/标点准确（Paraformer 强项），时序用比例近似即可。
_CLAUSE_SPLIT = re.compile(r'(?<=[，。！？；：、,.!?;:])(?=[^\s，。！？；：、,.!?;:])')


def _split_clauses(text, start, end):
    parts = [p for p in _CLAUSE_SPLIT.split(text) if p.strip()]
    if len(parts) <= 1:
        return [(start, end, text)]
    dur = max(0.1, end - start)
    total = sum(len(p) for p in parts) or 1
    out = []
    t = start
    for p in parts:
        frac = len(p) / total
        e = start + dur * (sum(len(x) for x in parts[:parts.index(p) + 1]) / total)
        e = round(min(end, e), 2)
        s = round(t, 2)
        if e <= s:
            e = s + 0.3
        out.append((s, e, p))
        t = e
    # 末句兜底对齐到句尾
    if out:
        out[-1] = (out[-1][0], end, out[-1][2])
    return out



def fast_punc_dict():
    """跳过 punc 模型的 jieba 用户词典加载。

    punc-ct-transformer 目录里带一个 11MB 的 jieba_usr_dict，funasr 在
    CTTransformer.__init__ 里同步 load_userdict，实测在这台机器上要 ~14s
    （十几万条词逐条 add_word，Windows 上还有杀软扫描开销），而 punc 模型
    的体积只有 1.1GB，重权重的加载才 4s——词典反而成了启动最慢的一步。
    关闭后 jieba_usr_dict=None，喂给 punc 的文本按字切分（utils.split_words
    的无词典分支），标点结果与开词典实测逐字一致（仅末尾「吧。」/「吧？」这类
    一字之差），但省掉整段加载。需要回到旧行为：ASR_JIEBA_DICT=1。
    """
    if os.environ.get('ASR_JIEBA_DICT', '0') == '1':
        return False
    try:
        import jieba
        jieba.load_userdict = lambda *a, **k: None
        jieba.add_word = lambda *a, **k: None
        return True
    except Exception as e:
        log('PUNC_DICT patch failed: %s' % e)
        return False


def build_funasr(args, backend):
    """构建 FunASR 模型（只构建一次，供批量推理复用）"""
    if fast_punc_dict():
        log('PUNC_DICT jieba user dict skipped (fast path)')
    t_build = time.time()
    from funasr import AutoModel
    log('IMPORT_FUNASR %.1fs' % (time.time() - t_build))

    model_dir = os.path.normpath(args.model)
    parent = os.path.dirname(model_dir)
    vad_dir = os.path.join(parent, 'fsmn-vad')
    punc_dir = os.path.join(parent, 'punc-ct-transformer')

    def build(**kw):
        # disable_update 在不同 funasr 版本参数名不同；失败则忽略该选项
        try:
            return AutoModel(**kw, disable_update=True)
        except TypeError:
            kw.pop('disable_update', None)
            return AutoModel(**kw)

    if backend == 'sensevoice':
        # SenseVoice 该版本输出无标点，单独接 punc 模型补标点（punc 目录与模型同父）
        model = build(model=model_dir, vad_model=vad_dir, device='cpu')
        punc_model = build(model=punc_dir, device='cpu') if os.path.isdir(punc_dir) else None
        strip_text = _strip_sensevoice_tags
    else:
        # paraformer-large：主体（paraformer + vad）先建，punc 单独建并在推理后补标点。
        # 之前把 punc_model 内联进同一个 AutoModel，会导致 paraformer + vad + punc 在加载
        # 阶段同驻内存、峰值冲到 ~4.8G，在本机触发 MemoryError（界面表现为「语音识别失败」）。
        # 拆开后：paraformer 常驻 ~2.5G，punc 单独建峰值 ~3.6G，稳过；补标点路径与 sensevoice 一致。
        model = build(model=model_dir, vad_model=vad_dir, device='cpu')
        punc_model = None
        try:
            if os.path.isdir(punc_dir):
                punc_model = build(model=punc_dir, device='cpu')
                log('PUNC_MODEL loaded')
        except Exception as e:
            # punc 加载失败（极端内存不足等）不阻断：退化为「无标点」识别，而非整批崩溃
            log('PUNC_LOAD_WARN %s (继续无标点识别)' % e)
        strip_text = lambda t: (t or '').strip()
    log('BUILD_MODEL %.1fs' % (time.time() - t_build))
    return model, punc_model, strip_text, os.path.basename(model_dir)


def run_funasr(model, punc_model, strip_text, wav_path, duration, backend, model_name):
    if backend == 'sensevoice':
        res = model.generate(input=wav_path, batch_size_s=300, language='zh')
    else:
        res = model.generate(input=wav_path, batch_size_s=300)

    if not res or not res[0]:
        return [], {'engine': 'funasr-' + backend, 'model': model_name}

    info0 = res[0]
    sentences = info0.get('sentence_info') or []
    if not sentences:
        # 个别版本把整段文本放在 'text'，无句级时间戳 -> 作为单句
        full = strip_text(info0.get('text', ''))
        sentences = [{'start': 0, 'end': int(duration * 1000), 'text': full}] if full else []

    # Paraformer 已拆出 punc（单独构建）；SenseVoice 原本就无标点。两者都用 punc 模型补标点
    if backend in ('sensevoice', 'paraformer') and punc_model is not None and sentences:
        try:
            raw = [strip_text(s.get('text', '')) for s in sentences]
            punced = punc_model.generate(input=[t for t in raw if t]) or []
            for j, s in enumerate(sentences):
                if j < len(punced) and punced[j] and punced[j].get('text'):
                    s['text'] = punced[j]['text']
        except Exception as e:
            log('PUNC_WARN %s' % e)

    out_segs = []
    speech_total = 0.0
    for i, seg in enumerate(sentences):
        start_ms = float(seg.get('start', 0) or 0)
        end_ms = float(seg.get('end', 0) or 0)
        text = strip_text(seg.get('text', ''))
        if not text:
            continue
        start = round(start_ms / 1000.0, 2)
        end = round(end_ms / 1000.0, 2)
        if end <= start:
            end = start + 0.4
        speech_total += (end - start)
        # VAD 把整段连续语音合成一句时，句内并无词级时间戳。
        # 按标点切分子句，并把该句时长按字数比例分配给各子句，得到多条自然时序字幕。
        for sub in _split_clauses(text, start, end):
            out_segs.append({
                'start': sub[0],
                'end': sub[1],
                'text': sub[2],
                'words': None,  # 句级时间戳：交给上层按句断字幕
                **_SAFE_CONF,
            })
        if duration > 0:
            log('PROGRESS %.2f' % min(0.95, end / duration))

    # VAD 语音占比：纯音乐/环境音不应上字幕
    ratio = (speech_total / duration) if duration > 0 else 0
    if speech_total < 1.5 or ratio < 0.10:
        log('SPEECHLESS speech=%.2fs ratio=%.3f' % (speech_total, ratio))
        out_segs = []

    return out_segs, {
        'engine': 'funasr-' + backend,
        'model': model_name,
        'computeType': 'cpu',
        'language': 'zh',
        'languageProbability': 1.0,
    }


def process_batch(inputs, backend, models, args, t0):
    """处理一批文件，返回 results 数组（与现有格式一致）"""
    wmodel = models.get('wmodel')
    fmodel = models.get('fmodel')
    fpunc = models.get('fpunc')
    fstrip = models.get('fstrip')
    fname = models.get('fname')
    n = len(inputs)
    results = []
    for i, src in enumerate(inputs):
        log('FILE %d %d' % (i, n))
        tmpdir = tempfile.mkdtemp(prefix='asr_')
        wav = os.path.join(tmpdir, 'a.wav')
        try:
            extract_wav(args.ffmpeg, src, wav)
            audio = read_wav(wav)
            sr = 16000
            duration = round(len(audio) / float(sr), 2)
            log('DECODED %.2fs' % duration)
            if duration < 0.2:
                raise RuntimeError('音频过短或无声，无法识别')

            if backend in ('paraformer', 'sensevoice'):
                out_segs, meta = run_funasr(fmodel, fpunc, fstrip, wav, duration, backend, fname)
            else:
                out_segs, meta = run_whisper(wmodel, audio, args, duration)

            log('PROGRESS 1.00')
            results.append({
                'ok': True,
                'index': i,
                'input': src,
                'engine': meta.get('engine'),
                'model': meta.get('model'),
                'computeType': meta.get('computeType'),
                'language': meta.get('language'),
                'languageProbability': meta.get('languageProbability'),
                'duration': duration,
                'text': ''.join(x['text'] for x in out_segs),
                'segments': out_segs,
                'seconds': round(time.time() - t0, 1),
                'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
            })
        except Exception as e:
            # 批量模式下单个文件失败不拖垮整批
            results.append({'ok': False, 'index': i, 'input': src, 'error': str(e)})
        finally:
            try:
                if os.path.exists(wav):
                    os.remove(wav)
                os.rmdir(tmpdir)
            except Exception:
                pass
    return results


def write_batch_output(results, inputs, args):
    """写结果文件并向 stdout 输出摘要 JSON（单文件保持旧格式）"""
    n = len(inputs)
    if n == 1:
        r0 = results[0]
        if not r0.get('ok'):
            sys.stdout.write(json.dumps({'ok': False, 'error': r0.get('error', '识别失败')}, ensure_ascii=False))
            sys.stdout.write('\n')
            return 1
        r0.pop('index', None)
        r0.pop('input', None)
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(r0, f, ensure_ascii=False)
        sys.stdout.write(json.dumps({'ok': True, 'out': args.out, 'segments': len(r0.get('segments', []))}, ensure_ascii=False))
    else:
        payload = {'ok': True, 'batch': True, 'count': n, 'results': results}
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        sys.stdout.write(json.dumps({
            'ok': True, 'out': args.out, 'batch': True, 'count': n,
            'results': [{'index': r['index'], 'ok': r.get('ok', False), 'segments': len(r.get('segments', []) or [])} for r in results],
        }, ensure_ascii=False))
    sys.stdout.write('\n')
    sys.stdout.flush()
    return 0


def serve_loop(backend, models, args):
    """常驻模式：模型只加载一次，从 stdin 逐行收请求，直到 stdin 关闭。
    请求行: {"id":1,"inputs":["a.mp4",...],"out":"结果.json"}
    响应:   stdout 一行 RESULT {json}（与单次模式摘要一致，另带 id）"""
    log('WORKER_READY')
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            sys.stdout.write(json.dumps({'id': None, 'ok': False, 'error': '请求解析失败: %s' % e}, ensure_ascii=False) + '\n')
            sys.stdout.flush()
            continue
        rid = req.get('id')
        inputs = [str(x) for x in (req.get('inputs') or [])]
        args.out = req.get('out') or args.out
        t0 = time.time()
        log('REQ %s files=%d' % (rid, len(inputs)))
        try:
            results = process_batch(inputs, backend, models, args, t0)
            rc = write_batch_output(results, inputs, args)
            info = {'id': rid, 'ok': rc == 0, 'out': args.out, 'batch': len(inputs) > 1, 'count': len(inputs)}
            if len(inputs) == 1 and rc == 0:
                info['segments'] = len(results[0].get('segments', []) or [])
            sys.stdout.write('RESULT ' + json.dumps(info, ensure_ascii=False) + '\n')
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write('RESULT ' + json.dumps({'id': rid, 'ok': False, 'error': str(e)}, ensure_ascii=False) + '\n')
            sys.stdout.flush()
    log('WORKER_EXIT')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=False, action='append', nargs='+',
                    help='一个或多个音视频文件（可重复 --input；批量模式只加载一次模型）')
    ap.add_argument('--model', required=True)
    ap.add_argument('--out', required=False, default='')
    ap.add_argument('--backend', default='whisper')
    ap.add_argument('--lang', default='zh')
    ap.add_argument('--ffmpeg', default='ffmpeg')
    ap.add_argument('--prompt', default='')
    ap.add_argument('--beam', type=int, default=5)
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--torch-threads', type=int, default=0,
                    help='torch 推理线程数（0=自动，最多 8）')
    ap.add_argument('--compute', default='int8')
    ap.add_argument('--vad', default='1')
    ap.add_argument('--serve', action='store_true',
                    help='常驻模式：模型加载一次后从 stdin 循环收请求（大幅省去重复加载）')
    args = ap.parse_args()

    backend = (args.backend or 'whisper').lower()
    serve = bool(args.serve)
    if not serve:
        if not args.input:
            print('--input is required (unless --serve)', file=sys.stderr)
            sys.exit(2)
        if not args.out:
            print('--out is required', file=sys.stderr)
            sys.exit(2)
    inputs = [f for group in (args.input or []) for f in group]

    # 模型只加载一次（这是此前每条素材耗 30-40 秒的元凶，推理本身不到 1 秒）
    t0 = time.time()
    # 长音频推理的收益来自多线程：funasr 默认只吃 4 线程，12 核机器上白白闲着
    try:
        import torch
        nt = args.torch_threads or min(8, os.cpu_count() or 4)
        torch.set_num_threads(nt)
        log('TORCH_THREADS %d' % nt)
    except Exception:
        pass
    wmodel = None
    fmodel = fpunc = fstrip = fname = None
    if backend in ('paraformer', 'sensevoice'):
        fmodel, fpunc, fstrip, fname = build_funasr(args, backend)
    else:
        wmodel = build_whisper(args)
    models = {'wmodel': wmodel, 'fmodel': fmodel, 'fpunc': fpunc, 'fstrip': fstrip, 'fname': fname}
    log('MODEL_READY %.1fs' % (time.time() - t0))

    if serve:
        serve_loop(backend, models, args)
        return

    results = process_batch(inputs, backend, models, args, t0)
    try:
        rc = write_batch_output(results, inputs, args)
        sys.exit(rc)
    except SystemExit:
        raise
    except Exception as e:
        sys.stdout.write(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        sys.stdout.write('\n')
        sys.exit(1)


if __name__ == '__main__':
    main()
