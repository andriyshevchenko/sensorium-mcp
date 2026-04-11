package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// NotifyOperator sends a message via Telegram to the operator.
// Silently fails if credentials are not configured.
func NotifyOperator(cfg Config, log *Logger, text string, threadID int) {
	if cfg.TelegramToken == "" || cfg.TelegramChatID == "" {
		log.Debug("NotifyOperator: skipped (no Telegram credentials)")
		return
	}

	log.Debug("NotifyOperator: sending to chat %s (threadID=%d)", cfg.TelegramChatID, threadID)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	apiURL := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", cfg.TelegramToken)

	form := url.Values{}
	form.Set("chat_id", cfg.TelegramChatID)
	form.Set("text", text)
	form.Set("parse_mode", "HTML")
	if threadID > 0 {
		form.Set("message_thread_id", fmt.Sprintf("%d", threadID))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, strings.NewReader(form.Encode()))
	if err != nil {
		log.Warn("Telegram notify: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Warn("Telegram notify: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Warn("Telegram notify: HTTP %d", resp.StatusCode)
	} else {
		log.Debug("Telegram notify: sent OK (HTTP %d)", resp.StatusCode)
	}
}
