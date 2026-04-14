//go:build !windows

package main

import "errors"

func scheduleServiceRestartForUpdate(_ *Logger) error {
	return errors.New("not supported on this OS")
}
