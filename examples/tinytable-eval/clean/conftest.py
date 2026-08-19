import pathlib
import sys

# Guarantees `import tinytable` works regardless of the cwd/invocation style
# pytest is run with (e.g. `pytest -q tests/agent/` from inside this
# directory, or from a copy of it made by score.py) - see #91.
sys.path.insert(0, str(pathlib.Path(__file__).parent))
