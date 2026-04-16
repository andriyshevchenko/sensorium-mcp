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

func TestIsThreadRunning_True(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"running":true}`))
	}))
	defer srv.Close()

	mcp := &MCPClient{BaseURL: srv.URL, Client: srv.Client()}
	if !mcp.IsThreadRunning(context.Background(), 1234) {
		t.Error("expected thread to be running")
	}
}

func TestIsThreadRunning_False(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"running":false}`))
	}))
	defer srv.Close()

	mcp := &MCPClient{BaseURL: srv.URL, Client: srv.Client()}
	if mcp.IsThreadRunning(context.Background(), 1234) {
		t.Error("expected thread to not be running")
	}
}

func TestGetKeepAliveThreads_FallbackToThreadsEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/threads/keepalive":
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"not found"}`))
		case "/api/threads":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"threads":[{"threadId":1,"name":"root","type":"root","keepAlive":true},{"threadId":2,"name":"worker","type":"worker","keepAlive":true},{"threadId":3,"name":"off","type":"root","keepAlive":false}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	mcp := &MCPClient{BaseURL: srv.URL, Client: srv.Client()}
	threads, err := mcp.GetKeepAliveThreads(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(threads) != 1 {
		t.Fatalf("got %d threads, want 1", len(threads))
	}
	if got, _ := threads[0]["threadId"].(float64); int(got) != 1 {
		t.Fatalf("unexpected thread returned: %v", threads[0])
	}
}
