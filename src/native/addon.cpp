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

  auto midMags = capture->getMidMagnitudes();
  auto sideMags = capture->getSideMagnitudes();
  bool beat = capture->getBeat();
  float volume = capture->getVolume();

  Napi::Object result = Napi::Object::New(env);

  Napi::Float32Array midData = Napi::Float32Array::New(env, midMags.size());
  for (size_t i = 0; i < midMags.size(); i++) midData[i] = midMags[i];

  Napi::Float32Array sideData = Napi::Float32Array::New(env, sideMags.size());
  for (size_t i = 0; i < sideMags.size(); i++) sideData[i] = sideMags[i];

  result.Set("midData", midData);
  result.Set("sideData", sideData);
  result.Set("beat", Napi::Boolean::New(env, beat));
  result.Set("volume", Napi::Number::New(env, volume));
  return result;
}

Napi::Value GetRawAudio(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!capture) return env.Null();

  auto left = capture->getRawLeft();
  auto right = capture->getRawRight();

  Napi::Object result = Napi::Object::New(env);

  Napi::Float32Array leftArr = Napi::Float32Array::New(env, left.size());
  for (size_t i = 0; i < left.size(); i++) leftArr[i] = left[i];

  Napi::Float32Array rightArr = Napi::Float32Array::New(env, right.size());
  for (size_t i = 0; i < right.size(); i++) rightArr[i] = right[i];

  result.Set("left", leftArr);
  result.Set("right", rightArr);
  result.Set("sampleRate", Napi::Number::New(env, capture->getSampleRate()));
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
  exports.Set("getRawAudio", Napi::Function::New(env, GetRawAudio));
  exports.Set("getSampleRate", Napi::Function::New(env, GetSampleRate));
  return exports;
}

NODE_API_MODULE(audio_capture, Init)
