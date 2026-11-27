package cmd

import (
	"maps"
	"testing"
)

func TestParseDeviceFlags(t *testing.T) {
	got, err := parseDeviceFlags([]string{"nvidia.com/gpu=2", "squat.ai/dri", "amd.com/gpu=0"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"nvidia.com/gpu": 2, "squat.ai/dri": 1, "amd.com/gpu": 0}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for _, bad := range []string{"=1", "nvidia.com/gpu=x", "nvidia.com/gpu=-1"} {
		if _, err := parseDeviceFlags([]string{bad}); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}

func TestParseDeviceFlagsRefusesRepeats(t *testing.T) {
	if _, err := parseDeviceFlags([]string{"nvidia.com/gpu=2", "nvidia.com/gpu=1"}); err == nil {
		t.Fatal("a repeated --device should be refused")
	}
}
