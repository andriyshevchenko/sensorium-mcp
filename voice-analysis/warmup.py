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

logger.info("All v2 models pre-downloaded successfully.")
