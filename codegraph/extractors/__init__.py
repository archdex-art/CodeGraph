"""Domain extractors (doc 03 Stage 2).

Each extractor is pluggable and isolated: a failure on one file degrades that
file's facts, never the whole index. Structural/process extractors emit
kind=FACT, confidence=1.0 (determinism rule, doc 03).
"""

from .base import Extraction, Extractor
from .python_ast import PythonAstExtractor
from .ownership import OwnershipExtractor

__all__ = ["Extraction", "Extractor", "PythonAstExtractor", "OwnershipExtractor"]
