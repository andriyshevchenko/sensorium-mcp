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

# 2. audeering emotion-dim model (arousal/dominance/valence)
logger.info("Downloading audeering emotion-dim model...")
from huggingface_hub import snapshot_download
import audonnx
_path_dim = snapshot_download("audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim")
_model_dim = audonnx.load(_path_dim)
logger.info("  ✓ audeering emotion-dim cached and loadable (outputs: %s)", list(_model_dim.outputs) if hasattr(_model_dim, 'outputs') else 'N/A')
del _model_dim

# 3. audeering age-gender model
logger.info("Downloading audeering age-gender model...")
_path_ag = snapshot_download("audeering/wav2vec2-large-robust-24-ft-age-gender")
_model_ag = audonnx.load(_path_ag)
logger.info("  ✓ audeering age-gender cached and loadable (outputs: %s)", list(_model_ag.outputs) if hasattr(_model_ag, 'outputs') else 'N/A')
del _model_ag

logger.info("All v2 models pre-downloaded successfully.")
