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

func TestIsAllowedProfileEnvKey(t *testing.T) {
	tests := []struct {
		key  string
		want bool
	}{
		{key: "TELEGRAM_TOKEN", want: true},
		{key: "MCP_HTTP_PORT", want: true},
		{key: "PATH", want: false},
		{key: "NODE_OPTIONS", want: false},
		{key: "bad-key", want: false},
		{key: "1BAD", want: false},
	}

	for _, tc := range tests {
		if got := isAllowedProfileEnvKey(tc.key); got != tc.want {
			t.Fatalf("isAllowedProfileEnvKey(%q) = %v, want %v", tc.key, got, tc.want)
		}
	}
}
