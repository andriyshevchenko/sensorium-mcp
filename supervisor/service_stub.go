//go:build !windows

package main

import "errors"

func runAsService() error             { return errors.New("not supported on this OS") }
func installService(_ string) error   { return errors.New("not supported on this OS") }
func uninstallService() error         { return errors.New("not supported on this OS") }
func startService() error             { return errors.New("not supported on this OS") }
func stopService() error              { return errors.New("not supported on this OS") }
func serviceStatus() error            { return errors.New("not supported on this OS") }
func isWindowsService() (bool, error) { return false, nil }
