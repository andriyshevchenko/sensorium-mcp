package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MCPClient wraps HTTP interactions with the MCP server.
type MCPClient struct {
	BaseURL string
	Secret  string
	Client  *http.Client
	Log     *Logger
}

func NewMCPClient(port int, secret string) *MCPClient {
	return &MCPClient{
		BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		Secret:  secret,
		Client:  &http.Client{Timeout: 10 * time.Second},
	}
}

func (m *MCPClient) authHeaders() map[string]string {
	h := map[string]string{
		"Content-Type": "application/json",
		"Accept":       "application/json",
	}
	if m.Secret != "" {
		h["Authorization"] = "Bearer " + m.Secret
	}
	return h
}

func (m *MCPClient) doReq(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = strings.NewReader(string(data))
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

// GetRootThreads fetches the list of root threads from the server.
func (m *MCPClient) GetRootThreads(ctx context.Context) ([]map[string]any, error) {
	return m.fetchThreadList(ctx, "/api/threads/roots")
}

// GetKeepAliveThreads fetches all threads with keepAlive=true (excluding worker threads).
func (m *MCPClient) GetKeepAliveThreads(ctx context.Context) ([]map[string]any, error) {
	threads, err := m.fetchThreadList(ctx, "/api/threads/keepalive")
	if err == nil {
		return threads, nil
	}

	// Backward compatibility: older MCP builds may not expose /api/threads/keepalive.
	if strings.Contains(err.Error(), "GET /api/threads/keepalive: 404") {
		if m.Log != nil {
			m.Log.Warn("/api/threads/keepalive unavailable (404); falling back to /api/threads with client-side filtering")
		}
		allThreads, err2 := m.fetchThreadList(ctx, "/api/threads")
		if err2 != nil {
			return nil, err2
		}
		return filterKeepAliveThreads(allThreads), nil
	}

	return nil, err
}

func filterKeepAliveThreads(threads []map[string]any) []map[string]any {
	result := make([]map[string]any, 0, len(threads))
	for _, t := range threads {
		keepAlive, _ := t["keepAlive"].(bool)
		if !keepAlive {
			continue
		}
		if typ, _ := t["type"].(string); typ == "worker" {
			continue
		}
		result = append(result, t)
	}
	return result
}

// fetchThreadList is a shared helper for thread-list endpoints.
func (m *MCPClient) fetchThreadList(ctx context.Context, path string) ([]map[string]any, error) {
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := m.doReq(ctx2, "GET", path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GET %s: %d", path, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Try bare array first, then wrapped {"threads": [...]}
	var result []map[string]any
	if err := json.Unmarshal(body, &result); err == nil {
		return result, nil
	}
	var wrapped struct {
		Threads []map[string]any `json:"threads"`
	}
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return nil, fmt.Errorf("cannot parse %s response: %w", path, err)
	}
	return wrapped.Threads, nil
}

// IsThreadRunning checks if a specific thread is running on the MCP server.
func (m *MCPClient) IsThreadRunning(ctx context.Context, threadID int) bool {
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := m.doReq(ctx2, "GET", fmt.Sprintf("/api/threads/%d/running", threadID), nil)
	if err != nil {
		if m.Log != nil {
			m.Log.Debug("IsThreadRunning(%d): request failed: %v", threadID, err)
		}
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		if m.Log != nil {
			m.Log.Debug("IsThreadRunning(%d): HTTP %d", threadID, resp.StatusCode)
		}
		return false
	}
	var result struct {
		Running bool `json:"running"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		if m.Log != nil {
			m.Log.Debug("IsThreadRunning(%d): decode error: %v", threadID, err)
		}
		return false
	}
	if m.Log != nil {
		m.Log.Debug("IsThreadRunning(%d): running=%v", threadID, result.Running)
	}
	return result.Running
}

// IsThreadStuck checks the per-thread heartbeat to detect stuck threads.
func (m *MCPClient) IsThreadStuck(ctx context.Context, threadID int, threshold time.Duration) bool {
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := m.doReq(ctx2, "GET", fmt.Sprintf("/api/threads/%d/heartbeat", threadID), nil)
	if err != nil {
		if m.Log != nil {
			m.Log.Debug("IsThreadStuck(%d): heartbeat request failed: %v", threadID, err)
		}
		return false // can't determine — default to not stuck
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		if m.Log != nil {
			m.Log.Debug("IsThreadStuck(%d): heartbeat HTTP %d", threadID, resp.StatusCode)
		}
		return false
	}
	var result struct {
		LastActivityMs int64 `json:"lastActivityMs"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		if m.Log != nil {
			m.Log.Debug("IsThreadStuck(%d): heartbeat decode error: %v", threadID, err)
		}
		return false
	}
	if result.LastActivityMs <= 0 {
		if m.Log != nil {
			m.Log.Debug("IsThreadStuck(%d): no lastActivityMs data", threadID)
		}
		return false
	}
	age := time.Duration(time.Now().UnixMilli()-result.LastActivityMs) * time.Millisecond
	stuck := age > threshold
	if m.Log != nil {
		m.Log.Debug("IsThreadStuck(%d): age=%v threshold=%v stuck=%v", threadID, age.Round(time.Second), threshold, stuck)
	}
	return stuck
}

// parseJsonOrSse extracts JSON from either a plain JSON response or an SSE stream.
// The MCP SDK may return SSE format when Accept includes text/event-stream.
func parseJsonOrSse(body []byte, contentType string) (map[string]any, error) {
	if strings.Contains(contentType, "text/event-stream") {
		// Extract JSON from SSE data: lines
		for _, line := range strings.Split(string(body), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "data:") {
				jsonStr := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
				if jsonStr == "" {
					continue
				}
				var result map[string]any
				if err := json.Unmarshal([]byte(jsonStr), &result); err == nil {
					return result, nil
				}
			}
		}
		return nil, fmt.Errorf("no valid JSON found in SSE stream")
	}
	var result map[string]any
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return result, nil
}

// OpenMCPSession creates an MCP session via the initialize handshake.
// Returns the session ID or empty string on failure.
func (m *MCPClient) OpenMCPSession(ctx context.Context) (string, error) {
	if m.Log != nil {
		m.Log.Debug("OpenMCPSession: initiating handshake")
	}
	ctx2, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	initPayload := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-03-26",
			"capabilities":    map[string]any{},
			"clientInfo": map[string]any{
				"name":    "sensorium-supervisor",
				"version": "1.0.0",
			},
		},
	}

	resp, err := m.doReq(ctx2, "POST", "/mcp", initPayload)
	if err != nil {
		return "", fmt.Errorf("initialize: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("initialize HTTP %d", resp.StatusCode)
	}

	sessionID := resp.Header.Get("Mcp-Session-Id")
	if sessionID == "" {
		if m.Log != nil {
			m.Log.Debug("OpenMCPSession: no Mcp-Session-Id in response headers")
		}
		return "", fmt.Errorf("initialize succeeded but no session ID returned")
	}

	// Send initialized notification
	notifPayload := map[string]any{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	}
	notifReq, err := http.NewRequestWithContext(ctx2, "POST", m.BaseURL+"/mcp", nil)
	if err != nil {
		return sessionID, nil // session created, notification failed — non-fatal
	}
	data, err := json.Marshal(notifPayload)
	if err != nil {
		return sessionID, nil // session created, notification failed — non-fatal
	}
	notifReq.Body = io.NopCloser(strings.NewReader(string(data)))
	for k, v := range m.authHeaders() {
		notifReq.Header.Set(k, v)
	}
	notifReq.Header.Set("Mcp-Session-Id", sessionID)
	nResp, err := m.Client.Do(notifReq)
	if err == nil {
		nResp.Body.Close()
	}

	return sessionID, nil
}

// CloseMCPSession closes a session via HTTP DELETE.
func (m *MCPClient) CloseMCPSession(ctx context.Context, sessionID string) {
	if m.Log != nil {
		m.Log.Debug("CloseMCPSession: closing session %s", sessionID)
	}
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx2, "DELETE", m.BaseURL+"/mcp", nil)
	if err != nil {
		return
	}
	for k, v := range m.authHeaders() {
		req.Header.Set(k, v)
	}
	req.Header.Set("Mcp-Session-Id", sessionID)
	resp, err := m.Client.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}

// CallStartThread invokes the start_thread MCP tool via JSON-RPC.
func (m *MCPClient) CallStartThread(ctx context.Context, sessionID string, threadID int, sessionName, client, workingDir string) (string, error) {
	if m.Log != nil {
		m.Log.Debug("CallStartThread: threadID=%d session=%q client=%q workDir=%q", threadID, sessionName, client, workingDir)
	}
	ctx2, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	args := map[string]any{
		"threadId":  threadID,
		"name":      sessionName,
		"agentType": client,
	}
	if workingDir != "" {
		args["workingDirectory"] = workingDir
	}

	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      "start_thread",
			"arguments": args,
		},
	}

	req, err := http.NewRequestWithContext(ctx2, "POST", m.BaseURL+"/mcp", nil)
	if err != nil {
		return "", err
	}
	data, _ := json.Marshal(payload)
	req.Body = io.NopCloser(strings.NewReader(string(data)))
	for k, v := range m.authHeaders() {
		req.Header.Set(k, v)
	}
	req.Header.Set("Mcp-Session-Id", sessionID)

	resp, err := m.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("start_thread: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("start_thread HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	result, err := parseJsonOrSse(body, resp.Header.Get("Content-Type"))
	if err != nil {
		return "", fmt.Errorf("start_thread parse: %w", err)
	}

	// Check for JSON-RPC error
	if errObj, ok := result["error"]; ok {
		if errMap, ok := errObj.(map[string]any); ok {
			return "", fmt.Errorf("start_thread RPC error: %v", errMap["message"])
		}
		return "", fmt.Errorf("start_thread RPC error: %v", errObj)
	}

	// Extract text from result.content[0].text
	if res, ok := result["result"].(map[string]any); ok {
		if content, ok := res["content"].([]any); ok && len(content) > 0 {
			if item, ok := content[0].(map[string]any); ok {
				if text, ok := item["text"].(string); ok {
					return text, nil
				}
			}
		}
	}

	return "", nil
}
