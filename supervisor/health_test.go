package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetRootThreads_WrappedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"threads":[{"threadId":1327,"name":"Sensorium 1","keepAlive":true}]}`))
	}))
	defer srv.Close()

	mcp := &MCPClient{BaseURL: srv.URL, Client: srv.Client()}
	threads, err := mcp.GetRootThreads(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(threads) != 1 {
		t.Fatalf("got %d threads, want 1", len(threads))
	}
	if threads[0]["name"] != "Sensorium 1" {
		t.Errorf("name = %v, want Sensorium 1", threads[0]["name"])
	}
}

func TestGetRootThreads_BareArray(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"threadId":7526,"name":"Thread A"},{"threadId":8888,"name":"Thread B"}]`))
	}))
	defer srv.Close()

	mcp := &MCPClient{BaseURL: srv.URL, Client: srv.Client()}
	threads, err := mcp.GetRootThreads(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(threads) != 2 {
		t.Fatalf("got %d threads, want 2", len(threads))
	}
}

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

