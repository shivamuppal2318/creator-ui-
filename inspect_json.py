import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: inspect_json.py <path>")
        return 1
    path = sys.argv[1].strip("\"'")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    print(type(data).__name__)
    if isinstance(data, list):
        print(f"count={len(data)}")
        if data:
            item = data[0]
            print("first_keys=", list(item.keys())[:60])
            interesting = {}
            for key in [
                "url",
                "videoUrl",
                "mediaUrl",
                "transcript",
                "timestampedTranscript",
                "timestamped_transcript",
                "analysisStatus",
                "analysisProvider",
                "title",
            ]:
                if key in item:
                    interesting[key] = str(item.get(key))[:500]
            print("sample=", interesting)
    elif isinstance(data, dict):
        print(f"keys={list(data.keys())[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
