import os


ROOT = r"C:\Users\odckamgllan\Downloads"
TARGET = "abvaidya_transcripts.txt"


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
        text = f.read()
    lines = text.splitlines()
    print(f"lines={len(lines)}")
    print(f"reel_blocks={text.count('REEL ')}")
    print(f"transcribed={text.count('Status: transcribed')}")
    print(f"failed={text.count('Status: failed')}")
    print(f"skipped={text.count('Status: skipped')}")
    print("preview_start=")
    for line in lines[:40]:
        print(line.rstrip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
