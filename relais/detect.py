#!/usr/bin/env python3
# Vérifie qu'une personne est vraiment visible dans un extrait de vidéo (pour le résumé de la journée).
# Petit modèle de reconnaissance (MobileNet-SSD), exécuté sur la Freebox : aucune image ne sort de la maison.
# Usage : detect.py <vidéo> <début en s> <durée en s>   →   affiche {"score": 0..1, "at": s}
import sys, json, cv2

MODEL = '/opt/relais/models/'
PERSON = 15  # classe « personne » du modèle

def main():
    path, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    net = cv2.dnn.readNetFromCaffe(MODEL + 'deploy.prototxt', MODEL + 'mobilenet_iter_73000.caffemodel')
    cap = cv2.VideoCapture(path)
    best, best_at, t, step = 0.0, None, start, 0.7
    while t <= start + dur:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, img = cap.read()
        if not ok:
            break
        h, w = img.shape[:2]
        # l'image Imou 640×480 est un 16:9 écrasé : on lui rend sa largeur avant l'analyse
        if w * 3 == h * 4:
            img = cv2.resize(img, (int(h * 16 / 9), h))
        # deux passages : l'image entière, puis ses deux moitiés (personnes petites, caméras grand angle)
        hh, ww = img.shape[:2]
        crops = [img, img[:, : ww // 2 + ww // 10], img[:, ww // 2 - ww // 10 :]]
        for c in crops:
            blob = cv2.dnn.blobFromImage(cv2.resize(c, (300, 300)), 0.007843, (300, 300), 127.5)
            net.setInput(blob)
            det = net.forward()
            for i in range(det.shape[2]):
                if int(det[0, 0, i, 1]) == PERSON:
                    s = float(det[0, 0, i, 2])
                    if s > best:
                        best, best_at = s, t
        if best >= 0.8:
            break  # personne bien visible : inutile de continuer
        t += step
    print(json.dumps({'score': round(best, 3), 'at': best_at}))

if __name__ == '__main__':
    main()
