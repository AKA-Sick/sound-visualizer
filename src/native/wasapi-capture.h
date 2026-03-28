#ifndef WASAPI_CAPTURE_H
#define WASAPI_CAPTURE_H

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <vector>
#include <thread>
#include <mutex>
#include <atomic>
#include <chrono>

class WasapiCapture {
public:
  static const int FFT_SIZE = 2048;

  WasapiCapture();
  ~WasapiCapture();

  bool start();
  void stop();

  std::vector<float> getMagnitudes();
  bool getBeat();
  float getVolume();
  int getSampleRate();

private:
  void captureLoop();
  void processFFT(const std::vector<float>& samples);

  std::atomic<bool> running_;
  std::thread captureThread_;
  std::mutex dataMutex_;

  std::vector<float> magnitudes_;
  bool beat_;
  float volume_;
  int sampleRate_;

  double bassAvg_;
  std::chrono::steady_clock::time_point lastBeatTime_;
};

#endif
