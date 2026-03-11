"""
Pre-download all HuggingFace models during Docker build.
This avoids cold-start downloads when the container scales from zero.
"""

import logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from huggingface_hub import hf_hub_download

# 1. SpeechBrain ECAPA encoder (shared backbone for all classifiers)
logger.info("Downloading SpeechBrain ECAPA encoder...")
from speechbrain.inference.speaker import EncoderClassifier
EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    run_opts={"device": "cpu"},
)
logger.info("  ✓ ECAPA encoder cached")

# 2. Emotion (SVM, no scaler)
logger.info("Downloading VANPY emotion model...")
hf_hub_download(repo_id="griko/emotion_7_cls_svm_ecapa_ravdess", filename="svm_model.joblib")
logger.info("  ✓ Emotion model cached")

# 3. Gender (SVM + scaler)
logger.info("Downloading VANPY gender model...")
hf_hub_download(repo_id="griko/gender_cls_svm_ecapa_voxceleb", filename="svm_model.joblib")
hf_hub_download(repo_id="griko/gender_cls_svm_ecapa_voxceleb", filename="scaler.joblib")
logger.info("  ✓ Gender model cached")

# 4. Age (SVR + scaler)
logger.info("Downloading VANPY age model...")
hf_hub_download(repo_id="griko/age_reg_svr_ecapa_voxceleb2", filename="model.joblib")
hf_hub_download(repo_id="griko/age_reg_svr_ecapa_voxceleb2", filename="scaler.joblib")
logger.info("  ✓ Age model cached")

# 5. Height (SVR + scaler)
logger.info("Downloading VANPY height model...")
hf_hub_download(repo_id="griko/height_reg_svr_ecapa_voxceleb", filename="svr_model.joblib")
hf_hub_download(repo_id="griko/height_reg_svr_ecapa_voxceleb", filename="scaler.joblib")
logger.info("  ✓ Height model cached")

logger.info("All models pre-downloaded successfully.")
