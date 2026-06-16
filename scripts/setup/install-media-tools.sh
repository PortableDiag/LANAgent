#!/bin/bash

echo "Installing media processing tools for LANAgent..."

# Update package list
echo "Updating package list..."
sudo apt update

# Install ffmpeg
echo "Installing ffmpeg..."
sudo apt install -y ffmpeg

# Verify ffmpeg installation
if command -v ffmpeg &> /dev/null; then
    echo "✅ ffmpeg installed successfully"
    ffmpeg -version | head -n1
else
    echo "❌ ffmpeg installation failed"
    exit 1
fi

# Install yt-dlp
echo "Installing yt-dlp..."
# Using the official installation method
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Verify yt-dlp installation
if command -v yt-dlp &> /dev/null; then
    echo "✅ yt-dlp installed successfully"
    yt-dlp --version
else
    echo "❌ yt-dlp installation failed"
    exit 1
fi

# Install python3 and pip if not already installed (for yt-dlp dependencies)
echo "Ensuring python3 is installed..."
sudo apt install -y python3 python3-pip

# Install recommended dependencies for yt-dlp
echo "Installing optional dependencies for yt-dlp..."
pip3 install --user mutagen pycryptodomex websockets brotli certifi

echo "✅ All media tools installed successfully!"
echo ""
echo "Available tools:"
echo "- ffmpeg: $(ffmpeg -version | head -n1)"
echo "- yt-dlp: $(yt-dlp --version)"