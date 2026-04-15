package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Logger writes to both stderr and a rotating log file.
// Rotates daily (at midnight) and when the file exceeds maxSize bytes.
type Logger struct {
	mu        sync.Mutex
	logPath   string
	file      *os.File
	debug     bool
	size      int64
	maxSize   int64 // default 5 MB
	maxKeep   int   // max daily rotated files to keep
	today     string
	stopTimer chan struct{}
}

func NewLogger(logPath string) *Logger {
	l := &Logger{
		logPath:   logPath,
		debug:     os.Getenv("SUPERVISOR_DEBUG") == "1" || os.Getenv("SUPERVISOR_DEBUG") == "true",
		maxSize:   5 * 1024 * 1024, // 5 MB
		maxKeep:   7,               // keep 7 daily files
		stopTimer: make(chan struct{}),
	}
	// Rotate previous day's log on startup if needed
	l.today = time.Now().Format("2006-01-02")
	l.rotateDailyIfNeeded()
	l.openFile()
	l.startMidnightTimer()
	return l
}

func (l *Logger) openFile() {
	if l.logPath == "" {
		return
	}
	f, err := os.OpenFile(l.logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[WARN] cannot open log file %s: %v\n", l.logPath, err)
		return
	}
	l.file = f
	// Seed current size for rotation checks
	if info, err := f.Stat(); err == nil {
		l.size = info.Size()
	}
}

func (l *Logger) log(level, format string, args ...any) {
	ts := time.Now().Format("2006-01-02 15:04:05")
	msg := fmt.Sprintf(format, args...)
	line := fmt.Sprintf("[%s] [%s] %s\n", ts, level, msg)

	l.mu.Lock()
	defer l.mu.Unlock()
	// Always write to file for post-mortem debugging; only emit DEBUG to stderr
	// when SUPERVISOR_DEBUG is set.
	if level != "DEBUG" || l.debug {
		fmt.Fprint(os.Stderr, line)
	}
	if l.file != nil {
		n, err := l.file.WriteString(line)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[ERR] log write failed: %v\n", err)
		}
		l.size += int64(n)
		if l.maxSize > 0 && l.size >= l.maxSize {
			l.rotate()
		}
	}
}

func (l *Logger) Info(format string, args ...any)  { l.log("INFO", format, args...) }
func (l *Logger) Warn(format string, args ...any)  { l.log("WARN", format, args...) }
func (l *Logger) Error(format string, args ...any) { l.log("ERROR", format, args...) }
func (l *Logger) Debug(format string, args ...any) { l.log("DEBUG", format, args...) }

// rotateDailyIfNeeded renames the current log to a dated archive if it was
// written on a previous day. Called without mu held (used at startup and from
// the midnight timer before the lock is acquired).
func (l *Logger) rotateDailyIfNeeded() {
	info, err := os.Stat(l.logPath)
	if err != nil {
		return // file doesn't exist yet — nothing to rotate
	}
	modDay := info.ModTime().Format("2006-01-02")
	if modDay == l.today {
		return // same day — no rotation needed
	}
	// Rename to dated file
	ext := filepath.Ext(l.logPath)
	base := strings.TrimSuffix(l.logPath, ext)
	dated := fmt.Sprintf("%s.%s%s", base, modDay, ext)
	if err := os.Rename(l.logPath, dated); err != nil {
		fmt.Fprintf(os.Stderr, "[WARN] daily log rotate: %v\n", err)
	}
	l.pruneOldLogs()
}

// pruneOldLogs deletes daily log files beyond maxKeep. Called without mu held.
func (l *Logger) pruneOldLogs() {
	dir := filepath.Dir(l.logPath)
	base := strings.TrimSuffix(filepath.Base(l.logPath), filepath.Ext(l.logPath))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var dated []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, base+".") && name != filepath.Base(l.logPath) {
			dated = append(dated, filepath.Join(dir, name))
		}
	}
	sort.Strings(dated) // ascending — oldest first
	for len(dated) > l.maxKeep {
		os.Remove(dated[0])
		dated = dated[1:]
	}
}

// startMidnightTimer fires a daily rotation at local midnight.
func (l *Logger) startMidnightTimer() {
	go func() {
		for {
			now := time.Now()
			next := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location())
			select {
			case <-time.After(time.Until(next)):
			case <-l.stopTimer:
				return
			}
			l.mu.Lock()
			l.today = time.Now().Format("2006-01-02")
			if l.file != nil {
				l.file.Close()
				l.file = nil
			}
			l.rotateDailyIfNeeded()
			l.size = 0
			l.openFile()
			l.mu.Unlock()
		}
	}()
}

// rotate closes the current log file, renames it with a dated suffix for
// size-based rotation mid-day, and opens a fresh log. Called with mu held.
func (l *Logger) rotate() {
	if l.file != nil {
		l.file.Close()
		l.file = nil
	}
	// Use a timestamp suffix to avoid colliding with the daily dated file
	ts := time.Now().Format("2006-01-02T150405")
	ext := filepath.Ext(l.logPath)
	base := strings.TrimSuffix(l.logPath, ext)
	os.Rename(l.logPath, fmt.Sprintf("%s.%s%s", base, ts, ext))
	l.pruneOldLogs()

	// Open a fresh file
	l.size = 0
	f, err := os.OpenFile(l.logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[WARN] log rotate: cannot create fresh log: %v\n", err)
		return
	}
	l.file = f
}

func (l *Logger) Close() {
	if l.stopTimer != nil {
		close(l.stopTimer)
		l.stopTimer = nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		l.file.Close()
		l.file = nil
	}
}
