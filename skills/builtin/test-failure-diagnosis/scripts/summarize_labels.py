from collections import Counter
import json
import sys


labels = [value.strip().lower() for value in sys.argv[1:] if value.strip()]
print(json.dumps(dict(Counter(labels)), ensure_ascii=False, sort_keys=True))
