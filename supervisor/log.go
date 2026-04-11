package main

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// Logger writes to both stderr and a rotating log file.
// Rotates when the file exceeds maxSize bytes.
type Logger struct {
	mu      sync.Mutex
	logPath string
	file    *os.File
	debug   bool
	size    int64
	maxSize int64 // default 5 MB
	maxKeep int   // max rotated files to keep
}

func NewLogger(logPath string) *Logger {
	l := &Logger{
		logPath: logPath,
		debug:   os.Getenv("SUPERVISOR_DEBUG") == "1" || os.Getenv("SUPERVISOR_DEBUG") == "true",
		maxSize: 5 * 1024 * 1024, // 5 MB
		maxKeep: 3,
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
	fmt.Fprint(os.Stderr, line)
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
func (l *Logger) Debug(format string, args ...any) {
	if l.debug {
		l.log("DEBUG", format, args...)
	}
}

// rotate closes the current log file, renames it with a .1 suffix (shifting
// older rotated files), and opens a fresh log. Called with mu held.
func (l *Logger) rotate() {
	if l.file != nil {
		l.file.Close()
		l.file = nil
	}

	// Shift existing rotated logs: .3 → delete, .2 → .3, .1 → .2, current → .1
	for i := l.maxKeep; i >= 1; i-- {
		old := fmt.Sprintf("%s.%d", l.logPath, i)
		if i == l.maxKeep {
			os.Remove(old)
		} else {
			os.Rename(old, fmt.Sprintf("%s.%d", l.logPath, i+1))
		}
	}
	os.Rename(l.logPath, l.logPath+".1")

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
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		l.file.Close()
		l.file = nil
	}
}
