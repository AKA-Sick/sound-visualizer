#include "wasapi-capture.h"
#include <cmath>
#include <cstring>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// --- Radix-2 Cooley-Tukey FFT ---

struct Complex {
  double re, im;
  Complex(double r = 0, double i = 0) : re(r), im(i) {}
  Complex operator+(const Complex& o) const { return {re + o.re, im + o.im}; }
  Complex operator-(const Complex& o) const { return {re - o.re, im - o.im}; }
  Complex operator*(const Complex& o) const {
    return {re * o.re - im * o.im, re * o.im + im * o.re};
  }
};

static void fft(std::vector<Complex>& a) {
  int n = (int)a.size();
  if (n == 1) return;

  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }

  for (int len = 2; len <= n; len <<= 1) {
    double ang = -2.0 * M_PI / len;
    Complex wlen(cos(ang), sin(ang));
    for (int i = 0; i < n; i += len) {
      Complex w(1, 0);
      for (int j = 0; j < len / 2; j++) {
        Complex u = a[i + j];
        Complex v = a[i + j + len / 2] * w;
        a[i + j] = u + v;
        a[i + j + len / 2] = u - v;
        w = w * wlen;
      }
    }
  }
}

// --- WasapiCapture implementation ---

WasapiCapture::WasapiCapture()
    : running_(false), beat_(false), volume_(0.0f),
      sampleRate_(44100), bassAvg_(0.0), rawBufferSize_(0) {
  midMagnitudes_.resize(FFT_SIZE / 2, 0.0f);
  sideMagnitudes_.resize(FFT_SIZE / 2, 0.0f);
  lastBeatTime_ = std::chrono::steady_clock::now();
}

WasapiCapture::~WasapiCapture() { stop(); }

bool WasapiCapture::start() {
  if (running_) return true;
  running_ = true;
  captureThread_ = std::thread(&WasapiCapture::captureLoop, this);
  return true;
}

void WasapiCapture::stop() {
  running_ = false;
  if (captureThread_.joinable()) captureThread_.join();
}

std::vector<float> WasapiCapture::getMidMagnitudes() {
  std::lock_guard<std::mutex> lock(dataMutex_);
  return midMagnitudes_;
}

std::vector<float> WasapiCapture::getSideMagnitudes() {
  std::lock_guard<std::mutex> lock(dataMutex_);
  return sideMagnitudes_;
}

std::vector<float> WasapiCapture::getRawLeft() {
  std::lock_guard<std::mutex> lock(dataMutex_);
  return rawLeft_;
}

std::vector<float> WasapiCapture::getRawRight() {
  std::lock_guard<std::mutex> lock(dataMutex_);
  return rawRight_;
}

bool WasapiCapture::getBeat() {
  std::lock_guard<std::mutex> lock(dataMutex_);
  bool b = beat_;
  beat_ = false;
  return b;
}

float WasapiCapture::getVolume() {
  std::lock_guard<std::mutex> lock(dataMutex_);
  return volume_;
}

int WasapiCapture::getSampleRate() { return sampleRate_; }

std::vector<float> WasapiCapture::computeFFT(const std::vector<float>& samples) {
  std::vector<Complex> data(FFT_SIZE);
  for (int i = 0; i < FFT_SIZE; i++) {
    double window = 0.5 * (1.0 - cos(2.0 * M_PI * i / (FFT_SIZE - 1)));
    data[i] = Complex(samples[i] * window, 0);
  }

  fft(data);

  std::vector<float> mags(FFT_SIZE / 2);
  for (int i = 0; i < FFT_SIZE / 2; i++) {
    mags[i] = (float)(sqrt(data[i].re * data[i].re +
                            data[i].im * data[i].im) / FFT_SIZE);
  }
  return mags;
}

void WasapiCapture::processAudio(const std::vector<float>& midSamples, const std::vector<float>& sideSamples) {
  auto midMags = computeFFT(midSamples);
  auto sideMags = computeFFT(sideSamples);

  // RMS volume from mid channel
  float rmsSum = 0;
  for (int i = 0; i < FFT_SIZE; i++) rmsSum += midSamples[i] * midSamples[i];
  float rms = sqrtf(rmsSum / FFT_SIZE);

  // Beat detection on mid channel bass energy (20-200Hz)
  float binRes = (float)sampleRate_ / FFT_SIZE;
  int bassStart = std::max(1, (int)(20.0f / binRes));
  int bassEnd = std::min(FFT_SIZE / 2, (int)(200.0f / binRes));
  float bassEnergy = 0;
  for (int i = bassStart; i <= bassEnd; i++) bassEnergy += midMags[i];

  float alpha = 0.05f;
  bassAvg_ = alpha * bassEnergy + (1.0f - alpha) * bassAvg_;

  bool beatDetected = false;
  auto now = std::chrono::steady_clock::now();
  auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                     now - lastBeatTime_).count();
  if (bassEnergy > bassAvg_ * 1.5f && elapsed > 100) {
    beatDetected = true;
    lastBeatTime_ = now;
  }

  std::lock_guard<std::mutex> lock(dataMutex_);
  midMagnitudes_ = midMags;
  sideMagnitudes_ = sideMags;
  beat_ = beatDetected || beat_;
  volume_ = rms;
}

void WasapiCapture::captureLoop() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { running_ = false; return; }

  IMMDeviceEnumerator* enumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioClient* audioClient = nullptr;
  IAudioCaptureClient* captureClient = nullptr;
  WAVEFORMATEX* format = nullptr;

  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                        __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr)) goto cleanup;

  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr)) goto cleanup;

  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                         (void**)&audioClient);
  if (FAILED(hr)) goto cleanup;

  hr = audioClient->GetMixFormat(&format);
  if (FAILED(hr)) goto cleanup;

  sampleRate_ = format->nSamplesPerSec;

  hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, format,
                                nullptr);
  if (FAILED(hr)) goto cleanup;

  hr = audioClient->GetService(__uuidof(IAudioCaptureClient),
                                (void**)&captureClient);
  if (FAILED(hr)) goto cleanup;

  hr = audioClient->Start();
  if (FAILED(hr)) goto cleanup;

  {
    std::vector<float> midBuffer;
    std::vector<float> sideBuffer;
    std::vector<float> leftBuf;
    std::vector<float> rightBuf;
    midBuffer.reserve(FFT_SIZE * 2);
    sideBuffer.reserve(FFT_SIZE * 2);
    rawBufferSize_ = sampleRate_ * RAW_BUFFER_SECONDS;
    int channels = format->nChannels;
    int bitsPerSample = format->wBitsPerSample;

    while (running_) {
      Sleep(10);

      UINT32 packetLength = 0;
      hr = captureClient->GetNextPacketSize(&packetLength);
      if (FAILED(hr)) break;

      while (packetLength > 0) {
        BYTE* data = nullptr;
        UINT32 numFrames = 0;
        DWORD flags = 0;

        hr = captureClient->GetBuffer(&data, &numFrames, &flags, nullptr,
                                       nullptr);
        if (FAILED(hr)) break;

        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          for (UINT32 i = 0; i < numFrames; i++) {
            midBuffer.push_back(0.0f);
            sideBuffer.push_back(0.0f);
            leftBuf.push_back(0.0f);
            rightBuf.push_back(0.0f);
          }
        } else if (data) {
          if (bitsPerSample == 32) {
            float* samples = (float*)data;
            for (UINT32 i = 0; i < numFrames; i++) {
              float left = samples[i * channels];
              float right = channels > 1 ? samples[i * channels + 1] : left;
              midBuffer.push_back((left + right) / 2.0f);
              sideBuffer.push_back((left - right) / 2.0f);
              leftBuf.push_back(left);
              rightBuf.push_back(right);
            }
          } else if (bitsPerSample == 16) {
            short* samples = (short*)data;
            for (UINT32 i = 0; i < numFrames; i++) {
              float left = samples[i * channels] / 32768.0f;
              float right = channels > 1 ? samples[i * channels + 1] / 32768.0f : left;
              midBuffer.push_back((left + right) / 2.0f);
              sideBuffer.push_back((left - right) / 2.0f);
              leftBuf.push_back(left);
              rightBuf.push_back(right);
            }
          }
        }

        captureClient->ReleaseBuffer(numFrames);
        hr = captureClient->GetNextPacketSize(&packetLength);
        if (FAILED(hr)) break;
      }

      while ((int)midBuffer.size() >= FFT_SIZE && (int)sideBuffer.size() >= FFT_SIZE) {
        processAudio(midBuffer, sideBuffer);
        midBuffer.erase(midBuffer.begin(), midBuffer.begin() + FFT_SIZE);
        sideBuffer.erase(sideBuffer.begin(), sideBuffer.begin() + FFT_SIZE);
      }

      // Update raw L/R circular buffer
      {
        std::lock_guard<std::mutex> lock(dataMutex_);
        rawLeft_.insert(rawLeft_.end(), leftBuf.begin(), leftBuf.end());
        rawRight_.insert(rawRight_.end(), rightBuf.begin(), rightBuf.end());
        if ((int)rawLeft_.size() > rawBufferSize_) {
          rawLeft_.erase(rawLeft_.begin(), rawLeft_.end() - rawBufferSize_);
          rawRight_.erase(rawRight_.begin(), rawRight_.end() - rawBufferSize_);
        }
      }
      leftBuf.clear();
      rightBuf.clear();
    }
  }

  audioClient->Stop();

cleanup:
  if (format) CoTaskMemFree(format);
  if (captureClient) captureClient->Release();
  if (audioClient) audioClient->Release();
  if (device) device->Release();
  if (enumerator) enumerator->Release();
  CoUninitialize();
}
