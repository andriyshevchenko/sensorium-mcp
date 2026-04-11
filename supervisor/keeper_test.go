package main

import "testing"

func TestParseWorkerThreadID(t *testing.T) {
	tests := []struct {
		name string
		text string
		want int
	}{
		{"normal response", `{"threadId":11226,"status":"restarted","name":"Sensorium 2","pid":87108}`, 11226},
		{"already_running", `{"threadId":11226,"status":"already_running","name":"Sensorium 2","pid":40568}`, 11226},
		{"empty string", "", 0},
		{"no threadId", `{"status":"error"}`, 0},
		{"threadId zero", `{"threadId":0}`, 0},
		{"invalid JSON", `not json`, 0},
		{"negative threadId", `{"threadId":-5}`, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseWorkerThreadID(tt.text)
			if got != tt.want {
				t.Errorf("parseWorkerThreadID(%q) = %d, want %d", tt.text, got, tt.want)
			}
		})
	}
}
