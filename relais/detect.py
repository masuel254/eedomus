#!/usr/bin/env python3
# Vérifie qu'une personne est vraiment visible dans un extrait de vidéo (pour le résumé de la journée).
# Petit modèle de reconnaissance (MobileNet-SSD), exécuté sur la Freebox : aucune image ne sort de la maison.
# Usage : detect.py <vidéo> <début en s> <durée en s>   →   affiche {"score": 0..1, "at": s}
import sys, os, json, shutil, subprocess, tempfile, cv2

MODEL = '/opt/relais/models/'
PERSON = 15  # classe « personne » du modèle

def frames(path, start, dur):
    # images extraites par ffmpeg (plus fiable que la lecture d'OpenCV sur la Freebox), 1,5 image par seconde
    d = tempfile.mkdtemp(prefix='det-')
    try:
        subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', path, '-vf', 'fps=1.5', '-q:v', '3', d + '/f%04d.jpg'],
                       timeout=120, check=False)
        for n in sorted(os.listdir(d)):
            img = cv2.imread(os.path.join(d, n))
            if img is not None:
                yield img
    finally:
        shutil.rmtree(d, ignore_errors=True)

def main():
    path, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    net = cv2.dnn.readNetFromCaffe(MODEL + 'deploy.prototxt', MODEL + 'mobilenet_iter_73000.caffemodel')
    # réglages prudents (la Freebox a un processeur ARM, sur lequel certaines optimisations d'OpenCV faussent les résultats)
    mode = os.environ.get('DETECT_MODE', 'safe')
    net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV); net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
    if mode in ('safe', 'nofuse'):
        net.enableFusion(False)
    if mode in ('safe', 'one'):
        cv2.setNumThreads(1)
    best, seen, dbg = 0.0, 0, []
    for img in frames(path, start, dur):
        seen += 1
        h, w = img.shape[:2]
        # l'image Imou 640×480 est un 16:9 écrasé : on lui rend sa largeur avant l'analyse
        if w * 3 == h * 4:
            img = cv2.resize(img, (int(h * 16 / 9), h))
        # trois passages : l'image entière, puis ses deux moitiés (personnes petites, caméras grand angle)
        hh, ww = img.shape[:2]
        for c in (img, img[:, : ww // 2 + ww // 10], img[:, ww // 2 - ww // 10 :]):
            blob = cv2.dnn.blobFromImage(cv2.resize(c, (300, 300)), 0.007843, (300, 300), 127.5)
            net.setInput(blob)
            det = net.forward()
            if os.environ.get('DETECT_DEBUG') and len(dbg) < 6:
                dbg.append([[int(det[0, 0, i, 1]), round(float(det[0, 0, i, 2]), 3)] for i in range(min(5, det.shape[2]))])
            for i in range(det.shape[2]):
                if int(det[0, 0, i, 1]) == PERSON:
                    best = max(best, float(det[0, 0, i, 2]))
        if best >= 0.8:
            break  # personne bien visible : inutile de continuer
    # aucune image lue : on ne sait pas (le passage sera gardé)
    out = {'score': round(best, 3) if seen else None, 'frames': seen}
    if dbg: out['dbg'] = dbg
    print(json.dumps(out))

if __name__ == '__main__':
    main()
