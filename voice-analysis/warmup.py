"""
Pre-download all HuggingFace models during Docker build.
This avoids cold-start downloads when the container scales from zero.
"""

import logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 1. SpeechBrain ECAPA encoder (used by emotion, gender, age pipelines)
logger.info("Downloading SpeechBrain ECAPA encoder...")
from speechbrain.inference.speaker import EncoderClassifier
EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    run_opts={"device": "cpu"},
)
logger.info("  ✓ ECAPA encoder cached")

# 2. VANPY emotion model
logger.info("Downloading VANPY emotion model...")
from voice_emotion_classification import EmotionClassificationPipeline
EmotionClassificationPipeline.from_pretrained("griko/emotion_7_cls_svm_ecapa_ravdess")
logger.info("  ✓ Emotion model cached")

# 3. VANPY gender model
logger.info("Downloading VANPY gender model...")
from huggingface_hub import hf_hub_download
hf_hub_download(repo_id="griko/gender_cls_svm_ecapa_voxceleb", filename="svm_model.pkl")
logger.info("  ✓ Gender model cached")

# 4. VANPY age model
logger.info("Downloading VANPY age model...")
hf_hub_download(repo_id="griko/age_reg_ann_ecapa_librosa_combined", filename="ann_model.pkl")
logger.info("  ✓ Age model cached")

logger.info("All models pre-downloaded successfully.")
