package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsServerReady_Healthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
	}))
	defer srv.Close()

	mcp := &MCPClient{BaseURL: srv.URL, Client: srv.Client()}
	if !mcp.IsServerReady(context.Background()) {
		t.Error("expected server to be ready")
	}
}

func TestIsServerReady_Down(t *testing.T) {
	mcp := &MCPClient{BaseURL: "http://127.0.0.1:1", Client: http.DefaultClient}
	if mcp.IsServerReady(context.Background()) {
		t.Error("expected server to be unreachable")
	}
}

