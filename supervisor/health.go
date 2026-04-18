package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// MCPClient wraps HTTP interactions with the MCP server.
type MCPClient struct {
	BaseURL string
	Secret  string
	Client  *http.Client
	Log     *Logger
	headers map[string]string
}

func NewMCPClient(port int, secret string) *MCPClient {
	h := map[string]string{
		"Content-Type": "application/json",
		"Accept":       "application/json",
	}
	if secret != "" {
		h["Authorization"] = "Bearer " + secret
	}
	return &MCPClient{
		BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		Secret:  secret,
		Client:  &http.Client{Timeout: 10 * time.Second},
		headers: h,
	}
}

func (m *MCPClient) authHeaders() map[string]string {
	return m.headers
}

func (m *MCPClient) doReq(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, m.BaseURL+path, bodyReader)
	if err != nil {
		return nil, err
	}
	for k, v := range m.authHeaders() {
		req.Header.Set(k, v)
	}
	return m.Client.Do(req)
}

// IsServerReady checks if the MCP server is responding (OPTIONS /mcp).
func (m *MCPClient) IsServerReady(ctx context.Context) bool {
	ctx2, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	resp, err := m.doReq(ctx2, "OPTIONS", "/mcp", nil)
	if err != nil {
		if m.Log != nil {
			m.Log.Debug("IsServerReady: OPTIONS /mcp failed: %v", err)
		}
		return false
	}
	defer resp.Body.Close()
	ready := resp.StatusCode < 500
	if m.Log != nil {
		m.Log.Debug("IsServerReady: OPTIONS /mcp => %d (ready=%v)", resp.StatusCode, ready)
	}
	return ready
}

// PrepareShutdown asks the MCP server to write a reconnect snapshot before
// the supervisor kills it.  Best-effort: returns any error but callers should
// proceed with the kill regardless.
func (m *MCPClient) PrepareShutdown(ctx context.Context) error {
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := m.doReq(ctx2, "POST", "/api/prepare-shutdown", nil)
	if err != nil {
		return fmt.Errorf("prepare-shutdown request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("prepare-shutdown HTTP %d", resp.StatusCode)
	}
	return nil
}

// WaitForReady polls the MCP server until it's ready, or timeout expires.
func (m *MCPClient) WaitForReady(ctx context.Context, pollInterval, timeout time.Duration) bool {
	ctx2, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		if m.IsServerReady(ctx2) {
			return true
		}
		select {
		case <-ctx2.Done():
			return false
		case <-ticker.C:
			// try again
		}
	}
}

