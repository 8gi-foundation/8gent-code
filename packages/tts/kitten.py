#!/usr/bin/env python3
"""
KittenTTS CLI wrapper.
Usage: python3 kitten.py "text to speak" voice_name /output/path.wav
Voices: Bella Jasper Luna Bruno Rosie Hugo Kiki Leo
"""
import sys, os
from kittentts import KittenTTS
import soundfile as sf

def main():
    if len(sys.argv) < 4:
        print("usage: kitten.py <text> <voice> <output.wav>", file=sys.stderr)
        sys.exit(1)

    text, voice, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    tts = KittenTTS()

    if voice not in tts.available_voices:
        voice = tts.available_voices[0]

    audio = tts.generate(text, voice=voice, speed=1.0)
    sf.write(out_path, audio, 22050)

if __name__ == "__main__":
    main()
