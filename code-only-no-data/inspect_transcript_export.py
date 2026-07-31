import json
import os


ROOT = r"C:\Users\odckamgllan\Downloads"
TARGET = "updated_with_transcripts.json"


def find_target(root: str, target: str) -> str | None:
    for dirpath, _, filenames in os.walk(root):
        if target in filenames:
            return os.path.join(dirpath, target)
    return None


def main() -> int:
    path = find_target(ROOT, TARGET)
    if not path:
      print("path=NOT_FOUND")
      return 1
    print(f"path={path}")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    print(f"type={type(data).__name__}")
    if isinstance(data, list):
        print(f"count={len(data)}")
        if data:
            item = data[0]
            print(f"keys={list(item.keys())[:60]}")
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
                    value = item.get(key)
                    print(f"{key}={str(value)[:500]}")
    else:
        print(f"keys={list(data.keys())[:60]}")
        reels = data.get("reels", [])
        print(f"reels={len(reels)}")
        print(
            "with_transcript="
            + str(sum(1 for reel in reels if str(reel.get("transcript", "")).strip()))
        )
        print(
            "with_timed="
            + str(
                sum(
                    1
                    for reel in reels
                    if reel.get("timestampedTranscript") or reel.get("timestamped_transcript")
                )
            )
        )
        print("ready=" + str(sum(1 for reel in reels if reel.get("analysisStatus") == "ready")))
        print("competitorProfiles=" + str(len(data.get("competitorProfiles", []))))
        print("competitorReels=" + str(len(data.get("competitorReels", []))))
        print("competitors=" + str(len(data.get("competitors", []))))
        if reels:
            item = reels[0]
            print(f"sample_reel_keys={list(item.keys())[:60]}")
            print(f"sample_url={item.get('url')}")
            print(f"sample_transcript={str(item.get('transcript') or '')[:500]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
