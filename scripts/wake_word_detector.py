#!/usr/bin/env python3
"""
Local Wake Word Detector using OpenWakeWord or Custom Models
Runs continuously, outputs JSON when wake word is detected
"""

import sys
import json
import argparse
import os
import numpy as np


def load_custom_onnx_model(model_path):
    """Load a custom ONNX model for standalone inference"""
    import onnxruntime as ort
    return ort.InferenceSession(model_path)


def resample_audio(audio_array, orig_sample_rate, target_sample_rate=16000):
    """Resample audio to target sample rate using linear interpolation"""
    if orig_sample_rate == target_sample_rate:
        return audio_array

    # Calculate the ratio and new length
    ratio = target_sample_rate / orig_sample_rate
    new_length = int(len(audio_array) * ratio)

    # Simple linear interpolation resampling
    old_indices = np.linspace(0, len(audio_array) - 1, new_length)
    return np.interp(old_indices, np.arange(len(audio_array)), audio_array)


def run_custom_model_inference(session, audio_array, sample_rate=16000, threshold=0.5):
    """Run inference on a custom standalone ONNX model"""
    # Normalize audio to [-1, 1]
    if audio_array.dtype == np.int16:
        audio_float = audio_array.astype(np.float32) / 32768.0
    else:
        audio_float = audio_array.astype(np.float32)

    # Resample to 16kHz if needed
    target_sample_rate = 16000
    if sample_rate != target_sample_rate:
        audio_float = resample_audio(audio_float, sample_rate, target_sample_rate)

    # Our custom model expects [batch, channels, samples]
    # Clip length is 2 seconds (32000 samples at 16kHz)
    target_length = target_sample_rate * 2

    # Pad or truncate
    if len(audio_float) < target_length:
        audio_float = np.pad(audio_float, (0, target_length - len(audio_float)))
    else:
        audio_float = audio_float[:target_length]

    # Reshape for model input
    input_data = audio_float.reshape(1, 1, -1).astype(np.float32)

    # Run inference
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    result = session.run([output_name], {input_name: input_data})[0]

    score = float(result[0][0])
    return score


def main():
    parser = argparse.ArgumentParser(description='Local wake word detector')
    parser.add_argument('--model', default='alexa', help='Wake word model to use')
    parser.add_argument('--model-path', help='Custom model path (overrides --model)')
    parser.add_argument('--custom', action='store_true', help='Use custom model format instead of OpenWakeWord')
    parser.add_argument('--threshold', type=float, default=0.5, help='Detection threshold (0-1)')
    parser.add_argument('--audio-file', help='Audio file to process (WAV format)')
    parser.add_argument('--chunk-size', type=int, default=1280, help='Audio chunk size')
    args = parser.parse_args()

    # Check for custom model path first
    custom_model_path = None
    if args.model_path:
        if os.path.exists(args.model_path):
            custom_model_path = args.model_path
        else:
            print(json.dumps({'error': f'Custom model not found: {args.model_path}'}))
            sys.exit(1)

    # Determine if using custom model or OpenWakeWord
    use_custom = args.custom or (custom_model_path and args.custom)

    # Check for custom alice model if model is 'alice' and no explicit path
    if args.model.lower() == 'alice' and not custom_model_path:
        # Check if custom alice model exists
        custom_alice_paths = [
            '$PRODUCTION_PATH/wake_word_models/models/alice_v0.1.onnx',
            os.path.expanduser('~/lanagent-deploy/wake_word_models/models/alice_v0.1.onnx'),
        ]
        for path in custom_alice_paths:
            if os.path.exists(path):
                custom_model_path = path
                use_custom = True
                break

    if not use_custom:
        # Map model names to paths (built-in OpenWakeWord models)
        model_map = {
            'alexa': 'alexa_v0.1',
            'hey_mycroft': 'hey_mycroft_v0.1',
            'hey_jarvis': 'hey_jarvis_v0.1',
            'hey_marvin': 'hey_marvin_v0.1',
        }
        model_name = model_map.get(args.model, args.model)

    try:
        if use_custom and custom_model_path:
            # Use custom ONNX model directly
            session = load_custom_onnx_model(custom_model_path)
        else:
            # Use OpenWakeWord
            from openwakeword.model import Model
            oww_model = Model(wakeword_models=[model_name])

        if args.audio_file:
            # Process audio file
            import wave

            with wave.open(args.audio_file, 'rb') as wf:
                sample_rate = wf.getframerate()
                n_channels = wf.getnchannels()
                sample_width = wf.getsampwidth()

                # Read all audio data
                audio_data = wf.readframes(wf.getnframes())

                # Convert to numpy array
                if sample_width == 2:
                    audio_array = np.frombuffer(audio_data, dtype=np.int16)
                else:
                    audio_array = np.frombuffer(audio_data, dtype=np.float32)

                # Convert stereo to mono if needed
                if n_channels == 2:
                    audio_array = audio_array.reshape(-1, 2).mean(axis=1).astype(np.int16)

                detected = False
                max_score = 0.0

                if use_custom and custom_model_path:
                    # Use custom model inference
                    max_score = run_custom_model_inference(
                        session, audio_array, sample_rate, args.threshold
                    )
                    detected = max_score >= args.threshold
                else:
                    # Process audio in chunks for OpenWakeWord
                    for i in range(0, len(audio_array), args.chunk_size):
                        chunk = audio_array[i:i + args.chunk_size]
                        if len(chunk) < args.chunk_size:
                            # Pad with zeros if needed
                            chunk = np.pad(chunk, (0, args.chunk_size - len(chunk)))

                        # Run prediction
                        prediction = oww_model.predict(chunk)

                        # Check all models for detection
                        for model_key in prediction:
                            score = prediction[model_key]
                            if score > max_score:
                                max_score = score
                            if score >= args.threshold:
                                detected = True

                # Output result as JSON
                result = {
                    'detected': detected,
                    'model': args.model,
                    'score': float(max_score),
                    'threshold': args.threshold,
                    'custom_model': use_custom and custom_model_path is not None
                }
                print(json.dumps(result))
                sys.exit(0 if detected else 1)
        else:
            # No file provided
            print(json.dumps({'error': 'No audio file provided'}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
