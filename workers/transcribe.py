import argparse
import json
import sys


def format_time_range(start, end):
    left = int(max(0, start))
    right = int(max(left + 1, round(end)))
    return f"{left}-{right}s"


def main():
    parser = argparse.ArgumentParser(description="Local transcription worker for Creator OS.")
    parser.add_argument("--file", required=True, help="Absolute path to local audio/video file.")
    parser.add_argument("--model", default="small", help="faster-whisper model size.")
    parser.add_argument("--compute-type", default="int8", help="faster-whisper compute type.")
    parser.add_argument("--device", default="auto", help="Device to run on: auto/cpu/cuda.")
    parser.add_argument("--language", default="", help="Optional fixed language code.")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "Missing dependency: install faster-whisper first with `pip install faster-whisper`.",
            file=sys.stderr,
        )
        return 1

    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments, info = model.transcribe(
            args.file,
            language=args.language or None,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        rows = []
        full_text = []
        for segment in segments:
          text = (segment.text or "").strip()
          if not text:
              continue
          rows.append({
              "time": format_time_range(float(segment.start or 0), float(segment.end or 0)),
              "text": text,
          })
          full_text.append(text)

        payload = {
            "text": " ".join(full_text).strip(),
            "language": getattr(info, "language", "") or "",
            "segments": rows,
        }
        print(json.dumps(payload, ensure_ascii=True))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
