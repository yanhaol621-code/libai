# -*- coding: utf-8 -*-
"""
人脸感知美颜：磨皮祛痘（双边滤波，只作用于人脸区域）+ 轻微瘦脸（关键点引导的水平收窄）。
用法:
  python beauty_face.py --input in.mp4 --output out_nosound.mp4 [--smooth 0.6] [--slim 0.5] [--maxw 1080]
输出为无音轨视频（音频由服务端后续 ffmpeg 步骤合并）。
无 face_landmarker.task 模型时会自动下载到 data/models/。
"""
import argparse
import json
import math
import os
import subprocess
import sys
import urllib.request

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# mediapipe 无法打开含中文的模型路径，优先用 ASCII junction（D:/mxsite -> 混剪网站）
if os.path.exists('D:/mxsite/data/projects'):
    MODEL_ROOT = 'D:/mxsite'
else:
    MODEL_ROOT = ROOT
MODEL_PATH = os.path.join(MODEL_ROOT, 'data', 'models', 'face_landmarker.task')
MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task'

# 人脸外轮廓关键点索引（FaceMesh 468 点拓扑）
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
             379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
             234, 127, 162, 21, 54, 103, 67, 109]

# 五官保护区：磨皮不能盖到眼睛/眉毛/嘴唇，否则脸就糊成一片
EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
EYE_R = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
BROW_L = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
BROW_R = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17,
        84, 181, 91, 146, 78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324,
        318, 402, 317, 14, 87, 178, 88, 95]
NOSTRIL = [98, 97, 2, 326, 327, 294, 168, 6, 197, 195, 5, 4, 1, 19, 94]
PROTECT_SETS = (EYE_L, EYE_R, BROW_L, BROW_R, LIPS, NOSTRIL)


def ensure_model():
    if os.path.exists(MODEL_PATH) and os.path.getsize(MODEL_PATH) > 100000:
        return MODEL_PATH
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    tmp = MODEL_PATH + '.download'
    print('downloading face_landmarker model...', flush=True)
    urllib.request.urlretrieve(MODEL_URL, tmp)
    os.replace(tmp, MODEL_PATH)
    return MODEL_PATH


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(1e-6, (e1 - e0)), 0.0, 1.0)
    return t * t * (3 - 2 * t)


class FaceBeauty:
    def __init__(self, smooth=0.6, slim=0.5):
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core.base_options import BaseOptions
        self.mp = mp
        opts = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=ensure_model()),
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
            min_face_detection_confidence=0.25,
            min_tracking_confidence=0.25,
        )
        self.landmarker = vision.FaceLandmarker.create_from_options(opts)
        self.smooth = smooth   # 0~1 磨皮强度
        self.slim = slim       # 0~1 瘦脸强度
        self.detail = 0.28     # 磨皮后回填的高频细节比例（太小塑料感、太大多余纹理）
        self._ts = 0

    def detect(self, bgr):
        h, w = bgr.shape[:2]
        # mediapipe 推理在降采样图上跑（关键点是归一化坐标），大幅提速
        small = bgr
        if w > 640:
            r = 640.0 / w
            small = cv2.resize(bgr, (640, max(2, int(round(h * r)))), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
        self._ts += 33
        res = self.landmarker.detect_for_video(img, self._ts)
        if not res.face_landmarks:
            return None
        lm = res.face_landmarks[0]
        pts = np.array([[p.x * w, p.y * h] for p in lm], dtype=np.float32)
        return pts  # (478,2) 全尺寸像素坐标

    def build_face_mask(self, bgr, pts):
        """人脸 bbox 局部遮罩（外轮廓外扩+羽化，并挖掉五官），返回 (mask, bbox)"""
        h, w = bgr.shape[:2]
        oval = pts[FACE_OVAL].astype(np.float32)
        x0, y0 = oval.min(axis=0)
        x1, y1 = oval.max(axis=0)
        mx = int((x1 - x0) * 0.22)
        my = int((y1 - y0) * 0.22)
        bx0, by0 = max(0, int(x0) - mx), max(0, int(y0) - my)
        bx1, by1 = min(w, int(x1) + mx), min(h, int(y1) + my)
        mw, mh = bx1 - bx0, by1 - by0
        if mw < 8 or mh < 8:
            return None, None
        # 羽化核跟着人脸尺寸走：人脸小的时候不要把整张脸糊掉
        feather = max(3, int(min(mw, mh) * 0.06))
        mask = np.zeros((mh, mw), np.uint8)
        cv2.fillConvexPoly(mask, (oval - [bx0, by0]).astype(np.int32), 255)
        mask = cv2.dilate(mask, np.ones((feather, feather), np.uint8))   # 沿脸缘外扩一点，发际/下巴过渡自然
        mask = cv2.GaussianBlur(mask, (0, 0), feather / 2.0)
        # 五官保护区：眼睛（连眼周）、眉毛、嘴唇、鼻孔不着色，保证五官清晰
        prot = np.zeros((mh, mw), np.uint8)
        for idx in PROTECT_SETS:
            poly = (pts[idx] - [bx0, by0]).astype(np.int32)
            cv2.fillConvexPoly(prot, cv2.convexHull(poly), 255)
        prot = cv2.dilate(prot, np.ones((max(3, feather), max(3, feather)), np.uint8))
        prot = cv2.GaussianBlur(prot, (0, 0), max(1.5, feather * 0.5))
        mask = mask.astype(np.float32) * (1.0 - prot.astype(np.float32) / 255.0)
        return mask.astype(np.uint8), (bx0, by0, bx1, by1)

    def slim_warp(self, bgr, pts):
        """按关键点做水平收窄（瘦脸）：下巴/脸颊区域向人脸中线轻微收缩"""
        if self.slim <= 0.01:
            return bgr
        h, w = bgr.shape[:2]
        cx = float(pts[10][0] + pts[152][0]) / 2.0        # 额顶-下巴连线中线
        y_eye = float(pts[33][1] + pts[263][1]) / 2.0      # 眼睛高度
        y_chin = float(pts[152][1])                        # 下巴高度
        face_w = float(np.linalg.norm(pts[234] - pts[454]))  # 两颊宽度
        if face_w < 8 or y_chin - y_eye < 8:
            return bgr
        s = 0.055 * self.slim                              # 最大收缩比例（稍微）
        win_w = face_w * 0.95                              # 水平作用窗
        # 只在人脸 bbox 附近做映射，避免整幅开销
        pad = int(face_w * 0.6)
        x0 = int(max(0, cx - win_w - pad)); x1 = int(min(w, cx + win_w + pad))
        y0 = int(max(0, y_eye - pad * 0.5)); y1 = int(min(h, y_chin + pad))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return bgr
        sub = np.ascontiguousarray(bgr[y0:y1, x0:x1])  # remap 要求连续内存
        ys, xs = np.mgrid[0:y1 - y0, 0:x1 - x0].astype(np.float32)  # remap 坐标必须相对子区域
        xs_abs = xs + x0
        # 垂直权重：眼下方渐起，下巴处最强，下颌以下快速衰减
        ny = (ys + y0 - y_eye) / (y_chin - y_eye)
        g = np.power(smoothstep(0.0, 1.0, ny), 1.4)
        g = g * np.exp(-np.square(np.maximum(ny - 1.0, 0.0)) * 10.0)
        # 水平窗：中线最强，向两侧平滑衰减到 0
        dx = np.abs(xs_abs - cx)
        hw = np.clip(1.0 - dx / win_w, 0.0, 1.0)
        hw = hw * hw * (3 - 2 * hw)
        map_x = xs + s * (xs_abs - cx) * g * hw
        map_y = ys.copy()
        out = cv2.remap(sub, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        bgr[y0:y1, x0:x1] = out
        return bgr

    def smooth_skin(self, bgr, pts, mask, bbox):
        """人脸区域磨皮：保边双边滤波 + 高频细节回填；五官由 mask 挖空保护，背景/产品不动"""
        if self.smooth <= 0.01 or mask is None:
            return bgr
        x0, y0, x1, y1 = bbox
        sub = np.ascontiguousarray(bgr[y0:y1, x0:x1])
        sh, sw = sub.shape[:2]
        st = float(np.clip(self.smooth, 0.0, 1.0))
        # 半分辨率做双边滤波（像素数 ×1/4，同等力度下覆盖空间范围 ×2），再放大回原尺寸
        hs = (max(2, sw // 2), max(2, sh // 2))
        half = cv2.resize(sub, hs, interpolation=cv2.INTER_AREA)
        # 色差容限跟着强度走：太小抹不掉痘印，太大就成色块
        sc = int(28 + 52 * st)
        sm = cv2.bilateralFilter(half, 9, sc, 9)
        sm = cv2.bilateralFilter(sm, 7, max(10, int(sc * 0.45)), 5)   # 第二轮只压渐变台阶，不扩大模糊范围
        sm = cv2.resize(sm, (sw, sh), interpolation=cv2.INTER_LINEAR).astype(np.float32)
        base = sub.astype(np.float32)
        # 高频细节回填：只补一点点皮肤纹理，补多了等于没磨（痘印又被"锐"回来）
        detail = base - cv2.GaussianBlur(base, (0, 0), 1.2)
        sm = sm + detail * float(self.detail)
        a = ((mask.astype(np.float32) / 255.0) * st)[..., None]
        out = base * (1.0 - a) + sm * a
        bgr[y0:y1, x0:x1] = np.clip(out, 0, 255).astype(np.uint8)
        return bgr

    def process(self, bgr):
        pts = self.detect(bgr)
        if pts is None:
            return bgr, False
        return self.apply(bgr, pts)

    def apply(self, bgr, pts):
        """对已检测出人脸的帧执行瘦脸+磨皮"""
        bgr = self.slim_warp(bgr, pts)
        mask, bbox = self.build_face_mask(bgr, pts)
        if mask is None:
            return bgr, False
        bgr = self.smooth_skin(bgr, pts, mask, bbox)
        return bgr, True

    @property
    def enabled(self):
        return self.smooth > 0.01 or self.slim > 0.01


def run_one(fb, inp, outp, args):
    """处理单个视频：探测参数 → 解码管道 → 逐帧处理 → 编码"""
    FFMPEG = os.path.join(ROOT, 'bin', 'ffmpeg.exe')
    FFPROBE = os.path.join(ROOT, 'bin', 'ffprobe.exe')
    if not os.path.exists(FFMPEG):
        FFMPEG, FFPROBE = 'ffmpeg', 'ffprobe'
    if not os.path.exists(inp):
        print('input not found: ' + inp, file=sys.stderr)
        return 2

    # 探测尺寸与帧率并计算目标尺寸（宽不超过 maxw，高宽都取偶数）
    # 注意：手机竖拍常见「编码 1920x1080 + rotate=90」，ffmpeg 解码时会自动旋正成 1080x1920，
    # 所以目标尺寸必须按旋正后的宽高算，否则会把竖屏纵向压扁（比例全错、画面发糊）。
    probe = subprocess.run(
        [FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', inp],
        capture_output=True, text=True)
    fps = 30.0
    try:
        streams = (json.loads(probe.stdout or '{}').get('streams') or [])
        st = streams[0]
        sw, sh = int(st['width']), int(st['height'])
        rot = 0
        tags = st.get('tags') or {}
        if 'rotate' in tags:
            rot = int(round(float(tags['rotate'])))
        for sd in (st.get('side_data_list') or []):
            if 'rotation' in sd:
                rot = int(round(float(sd['rotation'])))
        if abs(rot) % 180 == 90:          # 90/270 度：宽高互换
            sw, sh = sh, sw
        num, den = str(st.get('r_frame_rate') or '30/1').split('/')
        fps = float(num) / float(den or 1)
        if not (1 < fps < 240):
            fps = 30.0
    except Exception:
        print('ffprobe failed: %r' % (probe.stderr or probe.stdout), file=sys.stderr)
        return 2
    W = min(sw, args.maxw)
    if W % 2: W -= 1
    H = int(round(sh * W / sw))
    if H % 2: H -= 1
    frame_bytes = W * H * 3
    # 成片统一 30fps：源是 60fps（手机高帧率）时先降到 30，处理量减半、时间轴也和成片一致
    out_fps = 30.0 if fps > 45 else fps

    dec_args = [FFMPEG, '-y']
    if args.ss > 0:
        dec_args += ['-ss', '%.3f' % args.ss]
    dec_args += ['-i', inp]
    if args.t > 0:
        dec_args += ['-t', '%.3f' % args.t]
    dec_args += ['-vf', 'scale=%d:%d,fps=%.6f' % (W, H, out_fps),
                 '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-']
    dec = subprocess.Popen(dec_args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    enc_args = [FFMPEG, '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                '-s', '%dx%d' % (W, H), '-r', '%.6f' % out_fps, '-i', '-']
    if args.vf.strip():
        enc_args += ['-vf', args.vf.strip()]
    # 中间成品直接一档到位：superfast+crf19，后续服务端只需 -c:v copy 合音频，不再二次转码
    enc_args += ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '19',
                 '-pix_fmt', 'yuv420p', outp]
    enc = subprocess.Popen(enc_args, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    total = 0
    faces = 0
    detect_every = 2   # 人脸在相邻帧间几乎不动，稳定后可隔帧检测；省一半推理时间
    warm = 0
    miss = 0
    miss_limit = 12    # 短暂遮挡/转头（约 0.4 秒）继续沿用上一次关键点，效果不断档
    last_pts = None
    last_detect_at = 0
    detect_on = fb.enabled
    while True:
        raw = dec.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        bgr = np.frombuffer(raw, np.uint8).reshape(H, W, 3)  # 只读视图；需要写时再拷贝
        total += 1
        if detect_on:
            # 一旦丢脸/刚起步就逐帧检测（尽快找回人脸），稳定下来再隔帧，保证整段都有美颜
            every = 1 if (last_pts is None or miss > 0 or warm < 6) else detect_every
            if total - last_detect_at >= every:
                last_detect_at = total
                pts = fb.detect(bgr)
                if pts is not None:
                    last_pts = pts
                    miss = 0
                else:
                    miss += 1
                    if miss > miss_limit:   # 超过宽限期才认作人脸真的离开画面
                        last_pts = None
                warm += 1
            if last_pts is not None:
                bgr, hit = fb.apply(bgr.copy(), last_pts)
                faces += 1 if hit else 0
        enc.stdin.write(bgr.tobytes())
        if total == 1 or total % 30 == 0:   # 第 1 帧也报一次（让前端尽早拿到起点），之后每 30 帧（1 秒）报一次
            print('PROG frames=%d' % total, flush=True)

    dec.wait()
    enc.stdin.close()
    enc.wait()
    print('DONE frames=%d face_frames=%d' % (total, faces), flush=True)
    return 0 if total > 0 else 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', action='append', required=True)
    ap.add_argument('--output', action='append', required=True)
    ap.add_argument('--smooth', type=float, default=0.6)
    ap.add_argument('--slim', type=float, default=0.5)
    ap.add_argument('--maxw', type=int, default=1080)
    ap.add_argument('--ss', type=float, default=0, help='从源视频第几秒开始处理（跳过裁掉的开头）')
    ap.add_argument('--t', type=float, default=0, help='处理时长秒数，0=到结尾')
    ap.add_argument('--vf', default='', help='编码时附加的 ffmpeg 视频滤镜（调色等，省去二次转码）')
    args = ap.parse_args()
    if len(args.input) != len(args.output):
        print('--input 与 --output 数量不一致', file=sys.stderr)
        sys.exit(2)

    fb = None
    try:
        fb = FaceBeauty(args.smooth, args.slim)   # 模型只加载一次，可批量处理多个素材
    except Exception as e:
        print('facemesh unavailable: %r' % e, file=sys.stderr)
        sys.exit(3)

    rc = 0
    for inp, outp in zip(args.input, args.output):
        r = run_one(fb, inp, outp, args)
        if r != 0:
            rc = r
    sys.exit(rc)


if __name__ == '__main__':
    main()
