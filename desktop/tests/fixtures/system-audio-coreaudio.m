// Exercise the production setup and IO callback without opening any audio hardware or requesting OS consent.
#include "../../src-tauri/src/system_audio/coreaudio.m"
#include <assert.h>
#include <math.h>
#include <stdio.h>

static NSDictionary *createdAggregate;
static AudioDeviceIOBlock capturedIO;
static UInt32 tapChannelCount = 2;

static void feed(const AudioBufferList *input) {
    AudioTimeStamp time = {0};
    AudioBufferList playback = {0};
    capturedIO(&time, input, &time, &playback, &time);
}

OSStatus AudioObjectGetPropertyData(AudioObjectID object, const AudioObjectPropertyAddress *address,
                                   UInt32 qualifierSize, const void *qualifier, UInt32 *size, void *data) {
    if (address->mSelector == kAudioHardwarePropertyDefaultOutputDevice) {
        *(AudioDeviceID *)data = 7; // A duplex hardware output, which must never become an aggregate subdevice.
        *size = sizeof(AudioDeviceID);
        return noErr;
    }
    if (address->mSelector == kAudioTapPropertyFormat) {
        AudioStreamBasicDescription format = {0};
        format.mSampleRate = 48000;
        format.mFormatID = kAudioFormatLinearPCM;
        format.mFormatFlags = kAudioFormatFlagIsFloat;
        format.mBitsPerChannel = 32;
        format.mChannelsPerFrame = tapChannelCount;
        *(AudioStreamBasicDescription *)data = format;
        *size = sizeof(format);
        return noErr;
    }
    assert(!"Unexpected hardware property query");
    return -1;
}

OSStatus AudioHardwareCreateProcessTap(CATapDescription *description, AudioObjectID *tap) {
    *tap = 8;
    return noErr;
}

OSStatus AudioHardwareCreateAggregateDevice(CFDictionaryRef description, AudioObjectID *aggregate) {
    createdAggregate = [(__bridge NSDictionary *)description copy];
    *aggregate = 9;
    return noErr;
}

OSStatus AudioDeviceCreateIOProcIDWithBlock(AudioDeviceIOProcID *proc, AudioObjectID device,
                                          dispatch_queue_t queue, AudioDeviceIOBlock block) {
    capturedIO = [block copy];
    *proc = (AudioDeviceIOProcID)(uintptr_t)1;
    return noErr;
}

OSStatus AudioObjectAddPropertyListenerBlock(AudioObjectID object, const AudioObjectPropertyAddress *address,
                                            dispatch_queue_t queue, AudioObjectPropertyListenerBlock block) { return noErr; }
OSStatus AudioObjectRemovePropertyListenerBlock(AudioObjectID object, const AudioObjectPropertyAddress *address,
                                               dispatch_queue_t queue, AudioObjectPropertyListenerBlock block) { return noErr; }
OSStatus AudioDeviceStart(AudioObjectID device, AudioDeviceIOProcID proc) { return noErr; }
OSStatus AudioDeviceStop(AudioObjectID device, AudioDeviceIOProcID proc) { return noErr; }
OSStatus AudioDeviceDestroyIOProcID(AudioObjectID device, AudioDeviceIOProcID proc) { capturedIO = nil; return noErr; }
OSStatus AudioHardwareDestroyAggregateDevice(AudioObjectID device) { return noErr; }
OSStatus AudioHardwareDestroyProcessTap(AudioObjectID tap) { return noErr; }

int main(void) {
    @autoreleasepool {
        int status;
        void *handle = lumiverse_audio_tap_open(&status, false);
        assert(handle && status == kLumiverseTapOK);
        assert([createdAggregate[@kAudioAggregateDeviceSubDeviceListKey] count] == 0);
        assert(createdAggregate[@kAudioAggregateDeviceMainSubDeviceKey] == nil);
        assert([createdAggregate[@kAudioAggregateDeviceTapListKey] count] == 1);

        float out[8] = {0};
        float stereo[4] = {1, 0, 0, 0.5};
        AudioBufferList interleaved = {1, {{2, sizeof(stereo), stereo}}};
        feed(&interleaved);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 2);
        assert(out[0] == 0.5 && out[1] == 0.25);

        float left[2] = {0.4, 0.8};
        float right[2] = {0, 0.4};
        struct { UInt32 count; AudioBuffer buffers[2]; } planar = {
            2, {{1, sizeof(left), left}, {1, sizeof(right), right}},
        };
        feed((AudioBufferList *)&planar);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 2);
        assert(fabsf(out[0] - 0.2f) < 1e-6f && fabsf(out[1] - 0.6f) < 1e-6f);

        // A shorter plane cannot be read beyond its boundary.
        planar.buffers[1].mDataByteSize = sizeof(float);
        feed((AudioBufferList *)&planar);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 1);

        // Disabled input streams retain a byte count but have a null pointer.
        planar.buffers[1].mData = NULL;
        feed((AudioBufferList *)&planar);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 0);

        float microphone[2] = {0.9, 0.9};
        float silentTap[4] = {0};
        struct { UInt32 count; AudioBuffer buffers[2]; } unexpectedHardware = {
            2, {{1, sizeof(microphone), microphone}, {2, sizeof(silentTap), silentTap}},
        };
        feed((AudioBufferList *)&unexpectedHardware);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 0);
        lumiverse_audio_tap_close(handle);

        handle = lumiverse_audio_tap_open(&status, true);
        assert(handle && status == kLumiverseTapOK);
        feed(&interleaved);
        assert(lumiverse_audio_tap_read(handle, out, 1) == 0); // never split a stereo pair
        assert(lumiverse_audio_tap_read(handle, out, 3) == 2);
        assert(out[0] == 1 && out[1] == 0);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 2);
        assert(out[0] == 0 && out[1] == 0.5);
        planar.buffers[1].mData = right;
        planar.buffers[1].mDataByteSize = sizeof(right);
        feed((AudioBufferList *)&planar);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 4);
        assert(out[0] == left[0] && out[1] == right[0] && out[2] == left[1] && out[3] == right[1]);
        feed((AudioBufferList *)&unexpectedHardware);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 0);
        planar.buffers[1].mData = NULL;
        feed((AudioBufferList *)&planar);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 0);

        // Wrap and overflow preserve complete frames. A full ring drops the newest pair without changing either side.
        Ring *ring = ((__bridge LumiverseTapSession *)handle)->ring;
        atomic_store(&ring->head, RING_CAPACITY - 1);
        atomic_store(&ring->tail, RING_CAPACITY - 1);
        ring_write(ring, 0.1, 0.2);
        ring_write(ring, 0.3, 0.4);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 4);
        assert(out[0] == 0.1f && out[1] == 0.2f && out[2] == 0.3f && out[3] == 0.4f);
        for (size_t i = 0; i < RING_CAPACITY; i++) ring_write(ring, 0.5, -0.5);
        size_t before = atomic_load(&ring->head);
        ring_write(ring, 0.9, -0.9);
        assert(atomic_load(&ring->head) == before);
        assert(lumiverse_audio_tap_read(handle, out, 3) == 2 && out[0] == 0.5 && out[1] == -0.5);
        lumiverse_audio_tap_close(handle);

        // A genuinely mono tap is duplicated for stereo consumers.
        tapChannelCount = 1;
        handle = lumiverse_audio_tap_open(&status, true);
        AudioBufferList mono = {1, {{1, sizeof(left), left}}};
        feed(&mono);
        assert(lumiverse_audio_tap_read(handle, out, 8) == 4);
        assert(out[0] == left[0] && out[1] == left[0] && out[2] == left[1] && out[3] == left[1]);
        lumiverse_audio_tap_close(handle);
        puts("Core Audio tap-only setup and callback checks passed");
    }
}
