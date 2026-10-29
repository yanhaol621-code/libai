# -*- coding: utf-8 -*-
"""单帧调参：用 pipeline 产出的无美颜帧做底，比较不同磨皮参数的
皮肤高频（磨皮力度）与五官高频（是否糊），调完再跑整段视频。
用法: python test/tune_beauty.py
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from beauty_face import FaceBeauty  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME_SRC = os.path.join(BASE, 'data', 'temp', 'cmp', 'ns.mp4')
OUT = os.path.join(BASE, 'data', 'temp', 'cmp')


def lap_var(img, y0, y1, x0, x1):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    return cv2.Laplacian(g[y0:y1, x0:x1], cv2.CV_64F).var()


def save(p, img, crop=None, size=None):
    """cv2.imwrite 处理不了中文路径，走 imencode + 二进制写"""
    if crop is not None:
        y0, y1, x0, x1 = crop
        img = img[y0:y1, x0:x1]
    if size:
        img = cv2.resize(img, size, interpolation=cv2.INTER_CUBIC)
    ok, buf = cv2.imencode('.png', img)
    if ok:
        with open(p, 'wb') as f:
            f.write(buf.tobytes())


def grab(t=1.2):
    cap = cv2.VideoCapture(FRAME_SRC)
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, fr = cap.read()
    cap.release()
    if not ok:
        raise SystemExit('读取测试帧失败: ' + FRAME_SRC)
    return fr


def main():
    fr = grab()
    h, w = fr.shape[:2]
    print('frame', fr.shape)
    fb = FaceBeauty(smooth=0.6, slim=0.4)   # 模型只加载一次，参数复用
    pts = fb.detect(fr)
    if pts is None:
        raise SystemExit('没检测到人脸')
    fx0, fy0 = pts[:, 0].min(), pts[:, 1].min()
    fx1, fy1 = pts[:, 0].max(), pts[:, 1].max()
    fw, fh = fx1 - fx0, fy1 - fy0
    print('face bbox %.0f,%.0f - %.0f,%.0f' % (fx0, fy0, fx1, fy1))
    # 区域按人脸 bbox 相对定位
    ZONES = {
        '额头': (int(fy0 + fh * 0.06), int(fy0 + fh * 0.22), int(fx0 + fw * 0.30), int(fx0 + fw * 0.70)),
        '脸颊': (int(fy0 + fh * 0.52), int(fy0 + fh * 0.70), int(fx0 + fw * 0.05), int(fx0 + fw * 0.22)),
        '眼睛': (int(fy0 + fh * 0.34), int(fy0 + fh * 0.46), int(fx0 + fw * 0.30), int(fx0 + fw * 0.70)),
        '头发': (int(fy0 - fh * 0.22), int(fy0 - fh * 0.08), int(fx0 + fw * 0.30), int(fx0 + fw * 0.70)),
    }
    base = {k: lap_var(fr, *v) for k, v in ZONES.items()}
    print('原帧  ', {k: round(v, 1) for k, v in base.items()}, flush=True)
    for smooth in (0.5, 0.6, 0.75):
        for detail in (0.15, 0.28, 0.4):
            fb.smooth = smooth
            fb.detail = detail
            out, ok = fb.process(fr.copy())
            m = {k: lap_var(out, *v) for k, v in ZONES.items()}
            rel = {k: round(m[k] / max(1e-6, base[k]) * 100) for k in m}
            print('smooth=%.2f detail=%.2f 保留%%' % (smooth, detail), rel, flush=True)
            if abs(smooth - 0.6) < 1e-6 and abs(detail - 0.28) < 1e-6:
                save(os.path.join(OUT, 'tune_s60.png'), out)
                save(os.path.join(OUT, 'tune_base.png'), fr)
    print('done', flush=True)


if __name__ == '__main__':
    main()
