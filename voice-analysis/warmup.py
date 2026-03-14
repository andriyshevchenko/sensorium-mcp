"""
Pre-download all models during Docker build.
This avoids cold-start downloads when the container first starts.
"""

import logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 1. emotion2vec+ base via FunASR
logger.info("Downloading emotion2vec+ base...")
from funasr import AutoModel
_emotion = AutoModel(model="iic/emotion2vec_plus_base")
del _emotion
logger.info("  ✓ emotion2vec+ base cached")

# 2. audeering emotion-dim (processor + model weights)
logger.info("Downloading audeering emotion-dim model...")
from transformers import Wav2Vec2Processor
from huggingface_hub import snapshot_download
Wav2Vec2Processor.from_pretrained(
    "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim",
)
snapshot_download("audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim")
logger.info("  ✓ audeering emotion-dim cached")

# 3. audeering age-gender (processor + model weights)
logger.info("Downloading audeering age-gender model...")
Wav2Vec2Processor.from_pretrained(
    "audeering/wav2vec2-large-robust-24-ft-age-gender",
)
snapshot_download("audeering/wav2vec2-large-robust-24-ft-age-gender")
logger.info("  ✓ audeering age-gender cached")

# 4. PANNs CNN14 audio event detection
# panns_inference reads class_labels_indices.csv at import time, so we must
# download it BEFORE importing the package.
# Also, the package uses os.system('wget ...') to fetch the checkpoint, but
# wget is not available in python:3.11-slim. We download both files manually.
logger.info("Downloading PANNs CNN14 model...")
import os, urllib.request
panns_dir = os.path.expanduser("~/panns_data")
os.makedirs(panns_dir, exist_ok=True)
csv_path = os.path.join(panns_dir, "class_labels_indices.csv")
if not os.path.exists(csv_path):
    urllib.request.urlretrieve(
        "http://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv",
        csv_path,
    )
    logger.info("  ✓ AudioSet class_labels_indices.csv downloaded")
ckpt_path = os.path.join(panns_dir, "Cnn14_mAP=0.431.pth")
if not os.path.exists(ckpt_path) or os.path.getsize(ckpt_path) < 3e8:
    logger.info("  Downloading Cnn14 checkpoint (~327MB)...")
    urllib.request.urlretrieve(
        "https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1",
        ckpt_path,
    )
    logger.info(f"  ✓ Cnn14 checkpoint downloaded ({os.path.getsize(ckpt_path)} bytes)")
from panns_inference import AudioTagging
_at = AudioTagging(checkpoint_path=ckpt_path, device="cpu")
del _at
logger.info("  ✓ PANNs CNN14 cached")

logger.info("All models pre-downloaded successfully.")
