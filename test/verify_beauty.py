# -*- coding: utf-8 -*-
"""整段一致性核对：抽样多个时间点，比较「原片(同一条 pipeline 无美颜)」与「美颜后」
脸颊/五官区域的高频保留比例，确认磨皮从开头到结尾都在、且五官没被磨糊。
用法: python test/verify_beauty.py
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from beauty_face import FaceBeauty  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = os.path.join(BASE, 'data', 'temp', 'cmp', 'ns.mp4')                 # 同 pipeline、无美颜
BY = os.path.join(BASE, 'data', 'projects', 'prj_031ea6a4af51', 'materials', 'beauty', 'mat_aa2f3f681376.mp4')


def grab(path, t):
    cap = cv2.VideoCapture(path)
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, fr = cap.read()
    cap.release()
    return fr if ok else None


def lap(img, box):
    y0, y1, x0, x1 = box
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)[y0:y1, x0:x1]
    return cv2.Laplacian(g, cv2.CV_64F).var()


def main():
    fb = FaceBeauty(smooth=0.65, slim=0.4)
    print('%-6s %-22s %s' % ('时间', '检测', '脸颊/眼睛/头发 高频保留%'))
    for t in (0.2, 1.0, 2.0, 3.0, 4.0, 4.6, 5.0):
        a = grab(NS, t)
        b = grab(BY, t)
        if a is None or b is None:
            print('%.1fs  取帧失败' % t)
            continue
        pts = fb.detect(a)
        if pts is None:
            print('%.1fs  没检测到人脸（人脸已离开画面）' % t)
            continue
        fx0, fy0 = pts[:, 0].min(), pts[:, 1].min()
        fx1, fy1 = pts[:, 0].max(), pts[:, 1].max()
        fw, fh = fx1 - fx0, fy1 - fy0
        zones = {
            '脸颊': (int(fy0 + fh * 0.52), int(fy0 + fh * 0.70), int(fx0 + fw * 0.05), int(fx0 + fw * 0.22)),
            '眼睛': (int(fy0 + fh * 0.34), int(fy0 + fh * 0.46), int(fx0 + fw * 0.30), int(fx0 + fw * 0.70)),
            '头发': (int(fy0 - fh * 0.22), int(fy0 - fh * 0.08), int(fx0 + fw * 0.30), int(fx0 + fw * 0.70)),
        }
        out = []
        for k, z in zones.items():
            va, vb = lap(a, z), lap(b, z)
            out.append('%s %d%%' % (k, round(vb / max(1e-6, va) * 100)))
        print('%.1fs  人脸@(%d,%d)       %s' % (t, int(fx0), int(fy0), ' / '.join(out)), flush=True)


if __name__ == '__main__':
    main()
