package main

import "testing"

func TestParseHostMode_DefaultsAndValidation(t *testing.T) {
	tests := []struct {
		name             string
		value            string
		runningAsService bool
		want             string
	}{
		{
			name:             "empty defaults to service when running as service",
			value:            "",
			runningAsService: true,
			want:             "service",
		},
		{
			name:             "empty defaults to task when not running as service",
			value:            "",
			runningAsService: false,
			want:             "task",
		},
		{
			name:             "invalid falls back to service default for service mode",
			value:            "invalid",
			runningAsService: true,
			want:             "service",
		},
		{
			name:             "invalid falls back to task default for task mode",
			value:            "invalid",
			runningAsService: false,
			want:             "task",
		},
		{
			name:             "valid task accepted",
			value:            "task",
			runningAsService: true,
			want:             "service",
		},
		{
			name:             "valid service accepted",
			value:            "service",
			runningAsService: false,
			want:             "service",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseHostMode(tc.value, tc.runningAsService)
			if got != tc.want {
				t.Fatalf("parseHostMode(%q, runningAsService=%v) = %q, want %q", tc.value, tc.runningAsService, got, tc.want)
			}
		})
	}
}
