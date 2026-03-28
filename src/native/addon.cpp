#include <napi.h>
#include "wasapi-capture.h"

static WasapiCapture* capture = nullptr;

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!capture) capture = new WasapiCapture();
  return Napi::Boolean::New(env, capture->start());
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  if (capture) {
    capture->stop();
    delete capture;
    capture = nullptr;
  }
  return info.Env().Undefined();
}

Napi::Value GetAudioData(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!capture) return env.Null();

  auto mags = capture->getMagnitudes();
  bool beat = capture->getBeat();
  float volume = capture->getVolume();

  Napi::Object result = Napi::Object::New(env);

  Napi::Float32Array freqData = Napi::Float32Array::New(env, mags.size());
  for (size_t i = 0; i < mags.size(); i++) freqData[i] = mags[i];

  result.Set("frequencyData", freqData);
  result.Set("beat", Napi::Boolean::New(env, beat));
  result.Set("volume", Napi::Number::New(env, volume));
  return result;
}

Napi::Value GetSampleRate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!capture) return Napi::Number::New(env, 44100);
  return Napi::Number::New(env, capture->getSampleRate());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  exports.Set("getAudioData", Napi::Function::New(env, GetAudioData));
  exports.Set("getSampleRate", Napi::Function::New(env, GetSampleRate));
  return exports;
}

NODE_API_MODULE(audio_capture, Init)
