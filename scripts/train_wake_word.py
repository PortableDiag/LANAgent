#!/usr/bin/env python3
"""
Custom Wake Word Model Training for OpenWakeWord

This script trains a custom wake word model using:
1. Synthetic speech generation via Piper TTS
2. Audio augmentation (noise, reverb, speed variations)
3. Training with OpenWakeWord's embedding model
4. Export to ONNX format

Usage:
    python train_wake_word.py --wake-word "alice" --output-dir ./models
    python train_wake_word.py --wake-word "hey alice" --samples 5000 --epochs 50
"""

import os
import sys
import json
import argparse
import subprocess
import tempfile
import shutil
import wave
import struct
import random
from pathlib import Path
from typing import List, Tuple, Optional
import numpy as np

# Check for required dependencies
REQUIRED_PACKAGES = ['torch', 'torchaudio', 'onnx', 'onnxruntime']
OPTIONAL_PACKAGES = ['piper-tts', 'scipy', 'librosa']

def check_dependencies():
    """Check if required packages are installed"""
    missing = []
    for pkg in REQUIRED_PACKAGES:
        try:
            __import__(pkg.replace('-', '_'))
        except ImportError:
            missing.append(pkg)

    if missing:
        print(f"Missing required packages: {', '.join(missing)}")
        print(f"Install with: pip install {' '.join(missing)}")
        return False
    return True

def install_piper_tts():
    """Install Piper TTS if not available"""
    try:
        subprocess.run(['piper', '--help'], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("Piper TTS not found. Installing...")
        try:
            subprocess.run([sys.executable, '-m', 'pip', 'install', 'piper-tts'], check=True)
            return True
        except subprocess.CalledProcessError:
            print("Failed to install piper-tts. Trying alternative TTS...")
            return False

class SyntheticSpeechGenerator:
    """Generate synthetic speech samples using various TTS engines"""

    def __init__(self, output_dir: str, sample_rate: int = 16000):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.sample_rate = sample_rate
        self.tts_engine = self._detect_tts_engine()

    def _detect_tts_engine(self) -> str:
        """Detect available TTS engine"""
        # Try piper first (best quality for wake words)
        try:
            result = subprocess.run(['piper', '--help'], capture_output=True)
            if result.returncode == 0:
                return 'piper'
        except FileNotFoundError:
            pass

        # Try espeak-ng (widely available)
        try:
            result = subprocess.run(['espeak-ng', '--version'], capture_output=True)
            if result.returncode == 0:
                return 'espeak-ng'
        except FileNotFoundError:
            pass

        # Try espeak
        try:
            result = subprocess.run(['espeak', '--version'], capture_output=True)
            if result.returncode == 0:
                return 'espeak'
        except FileNotFoundError:
            pass

        # Fallback to Google TTS via gTTS
        try:
            from gtts import gTTS
            return 'gtts'
        except ImportError:
            pass

        return 'none'

    def generate_samples(self, text: str, num_samples: int,
                        voice_variations: bool = True) -> List[str]:
        """Generate synthetic speech samples"""
        print(f"Generating {num_samples} samples using {self.tts_engine}...")

        if self.tts_engine == 'none':
            print("No TTS engine available. Installing espeak-ng...")
            subprocess.run(['apt-get', 'install', '-y', 'espeak-ng'], capture_output=True)
            self.tts_engine = 'espeak-ng'

        samples = []

        for i in range(num_samples):
            output_file = self.output_dir / f"sample_{i:05d}.wav"

            if self.tts_engine == 'piper':
                success = self._generate_piper(text, output_file, i)
            elif self.tts_engine in ['espeak-ng', 'espeak']:
                success = self._generate_espeak(text, output_file, i, voice_variations)
            elif self.tts_engine == 'gtts':
                success = self._generate_gtts(text, output_file)
            else:
                success = False

            if success and output_file.exists():
                samples.append(str(output_file))

            if (i + 1) % 100 == 0:
                print(f"  Generated {i + 1}/{num_samples} samples...")

        print(f"Generated {len(samples)} samples")
        return samples

    def _generate_piper(self, text: str, output_file: Path, index: int) -> bool:
        """Generate using Piper TTS"""
        try:
            # Piper voices to use for variation
            voices = [
                'en_US-lessac-medium',
                'en_US-libritts-high',
                'en_GB-alan-medium',
                'en_US-amy-medium'
            ]
            voice = voices[index % len(voices)]

            cmd = [
                'piper',
                '--model', voice,
                '--output_file', str(output_file),
                '--sentence_silence', '0.1'
            ]

            result = subprocess.run(cmd, input=text.encode(), capture_output=True)
            return result.returncode == 0
        except Exception as e:
            return False

    def _generate_espeak(self, text: str, output_file: Path,
                         index: int, voice_variations: bool) -> bool:
        """Generate using espeak-ng"""
        try:
            # Voice variations for diversity
            if voice_variations:
                pitches = [80, 90, 100, 110, 120, 130, 140, 150]  # Male to female range
                speeds = [130, 140, 150, 160, 170, 180]  # Words per minute
                voices = ['en-us', 'en-gb', 'en-au', 'en-sc']  # English variants

                pitch = pitches[index % len(pitches)]
                speed = speeds[index % len(speeds)]
                voice = voices[index % len(voices)]
            else:
                pitch = 100
                speed = 150
                voice = 'en-us'

            cmd = [
                'espeak-ng' if self.tts_engine == 'espeak-ng' else 'espeak',
                '-v', voice,
                '-p', str(pitch),
                '-s', str(speed),
                '-w', str(output_file),
                text
            ]

            result = subprocess.run(cmd, capture_output=True)

            # Resample to 16kHz if needed
            if result.returncode == 0 and output_file.exists():
                self._resample_audio(output_file)

            return result.returncode == 0
        except Exception as e:
            print(f"espeak error: {e}")
            return False

    def _generate_gtts(self, text: str, output_file: Path) -> bool:
        """Generate using Google TTS"""
        try:
            from gtts import gTTS
            from pydub import AudioSegment

            # Generate MP3
            tts = gTTS(text=text, lang='en')
            mp3_file = output_file.with_suffix('.mp3')
            tts.save(str(mp3_file))

            # Convert to WAV
            audio = AudioSegment.from_mp3(str(mp3_file))
            audio = audio.set_frame_rate(self.sample_rate)
            audio = audio.set_channels(1)
            audio.export(str(output_file), format='wav')

            mp3_file.unlink()
            return True
        except Exception as e:
            return False

    def _resample_audio(self, audio_file: Path):
        """Resample audio to target sample rate using ffmpeg"""
        try:
            temp_file = audio_file.with_suffix('.tmp.wav')
            cmd = [
                'ffmpeg', '-y', '-i', str(audio_file),
                '-ar', str(self.sample_rate),
                '-ac', '1',
                str(temp_file)
            ]
            result = subprocess.run(cmd, capture_output=True)
            if result.returncode == 0:
                temp_file.replace(audio_file)
        except Exception:
            pass


class AudioAugmenter:
    """Apply audio augmentations for training data diversity"""

    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate

    def augment_samples(self, input_files: List[str], output_dir: str,
                       augmentations_per_sample: int = 5) -> List[str]:
        """Apply various augmentations to input samples"""
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        augmented = []
        print(f"Augmenting {len(input_files)} samples...")

        for i, input_file in enumerate(input_files):
            # Load audio
            audio = self._load_wav(input_file)
            if audio is None:
                continue

            # Original sample
            orig_file = output_path / f"aug_{i:05d}_orig.wav"
            self._save_wav(audio, str(orig_file))
            augmented.append(str(orig_file))

            # Apply augmentations
            for j in range(augmentations_per_sample):
                aug_audio = self._apply_random_augmentation(audio)
                aug_file = output_path / f"aug_{i:05d}_{j:02d}.wav"
                self._save_wav(aug_audio, str(aug_file))
                augmented.append(str(aug_file))

            if (i + 1) % 100 == 0:
                print(f"  Augmented {i + 1}/{len(input_files)} samples...")

        print(f"Created {len(augmented)} augmented samples")
        return augmented

    def _load_wav(self, filepath: str) -> Optional[np.ndarray]:
        """Load WAV file as numpy array"""
        try:
            with wave.open(filepath, 'rb') as wf:
                frames = wf.readframes(wf.getnframes())
                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
                audio = audio / 32768.0  # Normalize to [-1, 1]
                return audio
        except Exception:
            return None

    def _save_wav(self, audio: np.ndarray, filepath: str):
        """Save numpy array as WAV file"""
        try:
            # Clip and convert to int16
            audio = np.clip(audio, -1.0, 1.0)
            audio_int16 = (audio * 32767).astype(np.int16)

            with wave.open(filepath, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(self.sample_rate)
                wf.writeframes(audio_int16.tobytes())
        except Exception as e:
            print(f"Error saving {filepath}: {e}")

    def _apply_random_augmentation(self, audio: np.ndarray) -> np.ndarray:
        """Apply a random combination of augmentations"""
        augmentations = [
            self._add_noise,
            self._change_speed,
            self._change_pitch_simple,
            self._add_reverb_simple,
            self._change_volume
        ]

        # Apply 1-3 random augmentations
        num_augs = random.randint(1, 3)
        selected = random.sample(augmentations, num_augs)

        result = audio.copy()
        for aug_func in selected:
            result = aug_func(result)

        return result

    def _add_noise(self, audio: np.ndarray, snr_db: float = None) -> np.ndarray:
        """Add random noise"""
        if snr_db is None:
            snr_db = random.uniform(15, 30)  # Signal-to-noise ratio

        signal_power = np.mean(audio ** 2)
        noise_power = signal_power / (10 ** (snr_db / 10))
        noise = np.random.normal(0, np.sqrt(noise_power), len(audio))

        return audio + noise.astype(np.float32)

    def _change_speed(self, audio: np.ndarray) -> np.ndarray:
        """Change playback speed (simple resampling)"""
        speed_factor = random.uniform(0.85, 1.15)

        # Simple linear interpolation
        old_length = len(audio)
        new_length = int(old_length / speed_factor)

        old_indices = np.linspace(0, old_length - 1, new_length)
        new_audio = np.interp(old_indices, np.arange(old_length), audio)

        return new_audio.astype(np.float32)

    def _change_pitch_simple(self, audio: np.ndarray) -> np.ndarray:
        """Simple pitch shift via speed change + resample back"""
        # This is a simplified pitch shift - for production use librosa
        pitch_factor = random.uniform(0.9, 1.1)

        # Speed up/down
        old_length = len(audio)
        temp_length = int(old_length / pitch_factor)

        old_indices = np.linspace(0, old_length - 1, temp_length)
        temp_audio = np.interp(old_indices, np.arange(old_length), audio)

        # Resample back to original length
        new_indices = np.linspace(0, len(temp_audio) - 1, old_length)
        new_audio = np.interp(new_indices, np.arange(len(temp_audio)), temp_audio)

        return new_audio.astype(np.float32)

    def _add_reverb_simple(self, audio: np.ndarray) -> np.ndarray:
        """Add simple reverb effect"""
        # Simple delay-based reverb
        delay_samples = int(self.sample_rate * random.uniform(0.02, 0.08))
        decay = random.uniform(0.2, 0.5)

        reverb = np.zeros(len(audio) + delay_samples, dtype=np.float32)
        reverb[:len(audio)] = audio
        reverb[delay_samples:delay_samples + len(audio)] += audio * decay

        return reverb[:len(audio)]

    def _change_volume(self, audio: np.ndarray) -> np.ndarray:
        """Change volume randomly"""
        gain = random.uniform(0.5, 1.5)
        return audio * gain


class WakeWordTrainer:
    """Train custom wake word model using OpenWakeWord architecture"""

    def __init__(self, model_dir: str, sample_rate: int = 16000):
        self.model_dir = Path(model_dir)
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self.sample_rate = sample_rate

        # Import torch here to allow dependency checking first
        import torch
        import torch.nn as nn
        self.torch = torch
        self.nn = nn

        # Check for CUDA
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        print(f"Using device: {self.device}")

    def prepare_training_data(self, positive_files: List[str],
                             negative_files: List[str] = None,
                             clip_length_ms: int = 2000) -> Tuple[np.ndarray, np.ndarray]:
        """Prepare training data from audio files"""
        print("Preparing training data...")

        clip_samples = int(self.sample_rate * clip_length_ms / 1000)

        # Load positive samples
        positive_data = []
        for f in positive_files:
            audio = self._load_and_pad(f, clip_samples)
            if audio is not None:
                positive_data.append(audio)

        # Load or generate negative samples
        negative_data = []
        if negative_files:
            for f in negative_files:
                audio = self._load_and_pad(f, clip_samples)
                if audio is not None:
                    negative_data.append(audio)
        else:
            # Generate synthetic negative samples (silence + noise)
            print("Generating synthetic negative samples...")
            for _ in range(len(positive_data)):
                # Random noise
                noise = np.random.randn(clip_samples).astype(np.float32) * 0.1
                negative_data.append(noise)

        X_pos = np.array(positive_data)
        X_neg = np.array(negative_data)

        # Create labels
        y_pos = np.ones(len(X_pos))
        y_neg = np.zeros(len(X_neg))

        # Combine
        X = np.vstack([X_pos, X_neg])
        y = np.hstack([y_pos, y_neg])

        # Shuffle
        indices = np.random.permutation(len(X))
        X = X[indices]
        y = y[indices]

        print(f"Training data: {len(X)} samples ({len(X_pos)} positive, {len(X_neg)} negative)")
        return X, y

    def _load_and_pad(self, filepath: str, target_length: int) -> Optional[np.ndarray]:
        """Load audio and pad/truncate to target length"""
        try:
            with wave.open(filepath, 'rb') as wf:
                frames = wf.readframes(wf.getnframes())
                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32)
                audio = audio / 32768.0

                # Pad or truncate
                if len(audio) < target_length:
                    audio = np.pad(audio, (0, target_length - len(audio)))
                else:
                    audio = audio[:target_length]

                return audio
        except Exception:
            return None

    def train(self, X: np.ndarray, y: np.ndarray,
              epochs: int = 30, batch_size: int = 32,
              learning_rate: float = 0.001):
        """Train the wake word model"""
        print(f"Training model for {epochs} epochs...")

        # Convert to tensors
        X_tensor = self.torch.FloatTensor(X).unsqueeze(1)  # Add channel dim
        y_tensor = self.torch.FloatTensor(y)

        # Create simple model using factory function
        model = create_simple_wake_word_model(
            input_length=X.shape[1],
            sample_rate=self.sample_rate
        ).to(self.device)

        # Loss and optimizer
        criterion = self.nn.BCELoss()
        optimizer = self.torch.optim.Adam(model.parameters(), lr=learning_rate)

        # Training loop
        dataset = self.torch.utils.data.TensorDataset(X_tensor, y_tensor)
        loader = self.torch.utils.data.DataLoader(dataset, batch_size=batch_size, shuffle=True)

        for epoch in range(epochs):
            model.train()
            total_loss = 0
            correct = 0
            total = 0

            for batch_x, batch_y in loader:
                batch_x = batch_x.to(self.device)
                batch_y = batch_y.to(self.device)

                optimizer.zero_grad()
                outputs = model(batch_x).squeeze()
                loss = criterion(outputs, batch_y)
                loss.backward()
                optimizer.step()

                total_loss += loss.item()
                predicted = (outputs > 0.5).float()
                correct += (predicted == batch_y).sum().item()
                total += batch_y.size(0)

            accuracy = correct / total
            if (epoch + 1) % 5 == 0 or epoch == 0:
                print(f"  Epoch {epoch + 1}/{epochs} - Loss: {total_loss/len(loader):.4f}, Accuracy: {accuracy:.4f}")

        return model

    def export_onnx(self, model, output_path: str, wake_word_name: str):
        """Export model to ONNX format"""
        print(f"Exporting model to {output_path}...")

        model.eval()
        model.to('cpu')

        # Create dummy input
        dummy_input = self.torch.randn(1, 1, model.input_length)

        # Export
        self.torch.onnx.export(
            model,
            dummy_input,
            output_path,
            input_names=['audio'],
            output_names=['wake_word_probability'],
            dynamic_axes={
                'audio': {0: 'batch_size'},
                'wake_word_probability': {0: 'batch_size'}
            },
            opset_version=11
        )

        # Save metadata
        metadata_path = Path(output_path).with_suffix('.json')
        metadata = {
            'wake_word': wake_word_name,
            'sample_rate': self.sample_rate,
            'input_length': model.input_length,
            'model_type': 'simple_cnn'
        }
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2)

        print(f"Model exported successfully!")
        return output_path


def create_simple_wake_word_model(input_length: int, sample_rate: int = 16000):
    """Factory function to create a proper PyTorch model"""
    import torch.nn as nn

    class SimpleWakeWordModel(nn.Module):
        """Simple CNN-based wake word detection model"""

        def __init__(self):
            super().__init__()
            self.input_length = input_length
            self.sample_rate = sample_rate

            # Simple 1D CNN architecture
            self.conv_layers = nn.Sequential(
                nn.Conv1d(1, 32, kernel_size=80, stride=4),
                nn.ReLU(),
                nn.BatchNorm1d(32),
                nn.MaxPool1d(4),

                nn.Conv1d(32, 64, kernel_size=3, stride=1),
                nn.ReLU(),
                nn.BatchNorm1d(64),
                nn.MaxPool1d(4),

                nn.Conv1d(64, 128, kernel_size=3, stride=1),
                nn.ReLU(),
                nn.BatchNorm1d(128),
                nn.AdaptiveAvgPool1d(1)
            )

            self.classifier = nn.Sequential(
                nn.Flatten(),
                nn.Linear(128, 64),
                nn.ReLU(),
                nn.Dropout(0.3),
                nn.Linear(64, 1),
                nn.Sigmoid()
            )

        def forward(self, x):
            x = self.conv_layers(x)
            x = self.classifier(x)
            return x

    return SimpleWakeWordModel()


def download_negative_samples(output_dir: str, duration_hours: float = 0.5) -> List[str]:
    """Download or generate negative samples for training"""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"Generating negative samples...")

    # For a quick local solution, we'll generate synthetic negative samples
    # In production, you'd want real speech/noise data

    sample_rate = 16000
    clip_duration = 2  # seconds
    samples_per_hour = 3600 // clip_duration
    num_samples = int(samples_per_hour * duration_hours)

    files = []
    for i in range(num_samples):
        # Generate various types of negative audio
        clip_samples = sample_rate * clip_duration

        noise_type = i % 4
        if noise_type == 0:
            # White noise
            audio = np.random.randn(clip_samples).astype(np.float32) * 0.3
        elif noise_type == 1:
            # Pink noise (more realistic)
            audio = np.random.randn(clip_samples).astype(np.float32)
            # Simple low-pass filter approximation
            audio = np.convolve(audio, np.ones(10)/10, mode='same').astype(np.float32) * 0.5
        elif noise_type == 2:
            # Silence with occasional pops
            audio = np.zeros(clip_samples, dtype=np.float32)
            num_pops = random.randint(1, 5)
            for _ in range(num_pops):
                pos = random.randint(0, clip_samples - 100)
                audio[pos:pos+100] = np.random.randn(100).astype(np.float32) * 0.2
        else:
            # Brown noise
            audio = np.cumsum(np.random.randn(clip_samples)).astype(np.float32)
            audio = audio / np.max(np.abs(audio)) * 0.3

        # Save
        filepath = output_path / f"negative_{i:05d}.wav"
        with wave.open(str(filepath), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            audio_int16 = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
            wf.writeframes(audio_int16.tobytes())

        files.append(str(filepath))

    print(f"Generated {len(files)} negative samples")
    return files


def main():
    parser = argparse.ArgumentParser(
        description='Train custom wake word model for OpenWakeWord',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python train_wake_word.py --wake-word "alice"
  python train_wake_word.py --wake-word "hey alice" --samples 5000 --epochs 50
  python train_wake_word.py --wake-word "computer" --output-dir ./models
        """
    )

    parser.add_argument('--wake-word', required=True,
                       help='The wake word or phrase to train')
    parser.add_argument('--output-dir', default='./wake_word_models',
                       help='Output directory for trained model')
    parser.add_argument('--samples', type=int, default=2000,
                       help='Number of synthetic samples to generate')
    parser.add_argument('--augmentations', type=int, default=5,
                       help='Number of augmentations per sample')
    parser.add_argument('--epochs', type=int, default=30,
                       help='Training epochs')
    parser.add_argument('--batch-size', type=int, default=32,
                       help='Training batch size')
    parser.add_argument('--negative-hours', type=float, default=0.5,
                       help='Hours of negative samples to generate')
    parser.add_argument('--skip-generation', action='store_true',
                       help='Skip sample generation (use existing samples)')
    # Real voice sample support
    parser.add_argument('--use-real-samples', action='store_true',
                       help='Use real voice samples from directories instead of synthetic')
    parser.add_argument('--positive-dir',
                       help='Directory containing positive (wake word) voice samples')
    parser.add_argument('--negative-dir',
                       help='Directory containing negative (non-wake-word) voice samples')

    args = parser.parse_args()

    # Check dependencies
    if not check_dependencies():
        sys.exit(1)

    # Create output directories
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Sanitize wake word for filenames
    wake_word_safe = args.wake_word.lower().replace(' ', '_')

    samples_dir = output_dir / 'samples' / wake_word_safe
    augmented_dir = output_dir / 'augmented' / wake_word_safe
    negative_dir = output_dir / 'negative'
    models_dir = output_dir / 'models'

    if args.use_real_samples:
        # Use real voice samples from user
        print(f"\n=== Using real voice samples for '{args.wake_word}' ===")

        if not args.positive_dir:
            print("Error: --positive-dir required when using --use-real-samples")
            sys.exit(1)

        # Load positive samples
        positive_sample_dir = Path(args.positive_dir)
        base_samples = list(positive_sample_dir.glob('*.wav'))
        base_samples = [str(f) for f in base_samples]
        print(f"Found {len(base_samples)} positive samples in {args.positive_dir}")

        if not base_samples:
            print("Error: No positive samples found")
            sys.exit(1)

        # Augment real samples
        print(f"\n=== Augmenting real voice samples ===")
        augmenter = AudioAugmenter()
        positive_files = augmenter.augment_samples(
            base_samples, str(augmented_dir), args.augmentations
        )

        # Load or generate negative samples
        if args.negative_dir:
            negative_sample_dir = Path(args.negative_dir)
            neg_base_samples = list(negative_sample_dir.glob('*.wav'))
            neg_base_samples = [str(f) for f in neg_base_samples]
            print(f"Found {len(neg_base_samples)} negative samples in {args.negative_dir}")

            # Augment negative samples too
            if neg_base_samples:
                negative_files = augmenter.augment_samples(
                    neg_base_samples, str(negative_dir / 'augmented'), args.augmentations // 2
                )
            else:
                print("No negative samples found, generating synthetic negatives...")
                negative_files = download_negative_samples(str(negative_dir), args.negative_hours)
        else:
            print("\n=== Generating synthetic negative samples ===")
            negative_files = download_negative_samples(str(negative_dir), args.negative_hours)

    elif not args.skip_generation:
        # Step 1: Generate synthetic speech samples
        print(f"\n=== Step 1: Generating synthetic speech for '{args.wake_word}' ===")
        generator = SyntheticSpeechGenerator(str(samples_dir))
        base_samples = generator.generate_samples(args.wake_word, args.samples)

        if not base_samples:
            print("Error: Failed to generate samples. Check TTS installation.")
            sys.exit(1)

        # Step 2: Augment samples
        print(f"\n=== Step 2: Augmenting samples ===")
        augmenter = AudioAugmenter()
        positive_files = augmenter.augment_samples(
            base_samples, str(augmented_dir), args.augmentations
        )

        # Step 3: Generate negative samples
        print(f"\n=== Step 3: Generating negative samples ===")
        negative_files = download_negative_samples(str(negative_dir), args.negative_hours)
    else:
        # Load existing samples
        positive_files = list(augmented_dir.glob('*.wav'))
        negative_files = list(negative_dir.glob('*.wav'))
        positive_files = [str(f) for f in positive_files]
        negative_files = [str(f) for f in negative_files]
        print(f"Found {len(positive_files)} positive and {len(negative_files)} negative samples")

    # Step 4: Train model
    print(f"\n=== Step 4: Training wake word model ===")
    trainer = WakeWordTrainer(str(models_dir))
    X, y = trainer.prepare_training_data(positive_files, negative_files)

    model = trainer.train(X, y, epochs=args.epochs, batch_size=args.batch_size)

    # Step 5: Export model
    print(f"\n=== Step 5: Exporting model ===")
    model_path = models_dir / f"{wake_word_safe}_v0.1.onnx"
    trainer.export_onnx(model, str(model_path), args.wake_word)

    print(f"\n=== Training complete! ===")
    print(f"Model saved to: {model_path}")
    print(f"\nTo use this model, copy it to:")
    print(f"  $PRODUCTION_PATH/venv-wakeword/lib/python3.13/site-packages/openwakeword/resources/models/")
    print(f"\nOr specify the full path in your configuration.")


if __name__ == '__main__':
    main()
