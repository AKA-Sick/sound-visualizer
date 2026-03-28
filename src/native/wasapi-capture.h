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
  static const int RAW_BUFFER_SECONDS = 7;

  WasapiCapture();
  ~WasapiCapture();

  bool start();
  void stop();

  std::vector<float> getMidMagnitudes();
  std::vector<float> getSideMagnitudes();
  std::vector<float> getRawLeft();
  std::vector<float> getRawRight();
  bool getBeat();
  float getVolume();
  int getSampleRate();

private:
  void captureLoop();
  std::vector<float> computeFFT(const std::vector<float>& samples);
  void processAudio(const std::vector<float>& midSamples, const std::vector<float>& sideSamples);

  std::atomic<bool> running_;
  std::thread captureThread_;
  std::mutex dataMutex_;

  std::vector<float> midMagnitudes_;
  std::vector<float> sideMagnitudes_;
  std::vector<float> rawLeft_;
  std::vector<float> rawRight_;
  int rawBufferSize_;
  bool beat_;
  float volume_;
  int sampleRate_;

  double bassAvg_;
  std::chrono::steady_clock::time_point lastBeatTime_;
};

#endif
