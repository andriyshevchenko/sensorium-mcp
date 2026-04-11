package main

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// Logger writes to both stderr and a rotating log file.
type Logger struct {
	mu      sync.Mutex
	logPath string
	file    *os.File
	debug   bool
}

func NewLogger(logPath string) *Logger {
	l := &Logger{
		logPath: logPath,
		debug:   os.Getenv("SUPERVISOR_DEBUG") == "1" || os.Getenv("SUPERVISOR_DEBUG") == "true",
	}
	l.openFile()
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
}

func (l *Logger) log(level, format string, args ...any) {
	ts := time.Now().Format("2006-01-02 15:04:05")
	msg := fmt.Sprintf(format, args...)
	line := fmt.Sprintf("[%s] [%s] %s\n", ts, level, msg)

	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprint(os.Stderr, line)
	if l.file != nil {
		if _, err := l.file.WriteString(line); err != nil {
			fmt.Fprintf(os.Stderr, "[ERR] log write failed: %v\n", err)
		}
	}
}

func (l *Logger) Info(format string, args ...any)  { l.log("INFO", format, args...) }
func (l *Logger) Warn(format string, args ...any)  { l.log("WARN", format, args...) }
func (l *Logger) Error(format string, args ...any) { l.log("ERROR", format, args...) }
func (l *Logger) Debug(format string, args ...any) {
	if l.debug {
		l.log("DEBUG", format, args...)
	}
}

func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		l.file.Close()
		l.file = nil
	}
}
