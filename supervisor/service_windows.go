//go:build windows

package main

import (
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "SensoriumSupervisor"
const serviceDisplay = "Sensorium Supervisor"
const serviceDesc = "Keeps the sensorium-mcp server and agent threads running."

type supervisorService struct{}

func (s *supervisorService) Execute(args []string, r <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}

	done := make(chan error, 1)
	go func() {
		done <- runSupervisor(true)
	}()

	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for {
		select {
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				stopSupervisor()
				select {
				case err := <-done:
					if err != nil {
						fmt.Fprintf(os.Stderr, "Service shutdown with error: %v\n", err)
					}
				case <-time.After(15 * time.Second):
				}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				fmt.Fprintf(os.Stderr, "Service failed: %v\n", err)
			}
			return false, 0
		}
	}
}

func runAsService() error {
	return svc.Run(serviceName, &supervisorService{})
}

func installService(exePath, serviceUser, servicePassword string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("install failed: connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err == nil {
		s.Close()
		return fmt.Errorf("install failed: service %q already exists", serviceName)
	}

	cfg := mgr.Config{
		DisplayName:      serviceDisplay,
		Description:      serviceDesc,
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
	}
	if serviceUser != "" {
		cfg.ServiceStartName = serviceUser
		cfg.Password = servicePassword
		if servicePassword == "" {
			fmt.Printf("Installing service as passwordless identity %q\n", serviceUser)
		} else {
			fmt.Printf("Installing service as user %q\n", serviceUser)
		}
	} else {
		fmt.Println("Installing service as LocalSystem (default). Use -service-user to run as a specific user account.")
	}

	s, err = m.CreateService(serviceName, exePath, cfg)
	if err != nil {
		return fmt.Errorf("install failed: create service: %w", err)
	}
	defer s.Close()

	fmt.Printf("Service %q installed successfully.\n", serviceName)
	fmt.Printf("Start it with: %s start\n", filepathBase(exePath))
	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("uninstall failed: connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("uninstall failed: service %q not found: %w", serviceName, err)
	}
	defer s.Close()

	if err := s.Delete(); err != nil {
		return fmt.Errorf("uninstall failed: delete service: %w", err)
	}

	fmt.Printf("Service %q uninstalled.\n", serviceName)
	return nil
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("start failed: connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("start failed: service %q not found: %w", serviceName, err)
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		return fmt.Errorf("start failed: %w", err)
	}

	fmt.Printf("Service %q started.\n", serviceName)
	return nil
}

func stopService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("stop failed: connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("stop failed: service %q not found: %w", serviceName, err)
	}
	defer s.Close()

	if _, err := s.Control(svc.Stop); err != nil {
		return fmt.Errorf("stop failed: %w", err)
	}

	fmt.Printf("Service %q stopping.\n", serviceName)
	return nil
}

func serviceStatus() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("status failed: connect to service manager: %w", err)
	}
	defer m.Disconnect()

	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("status failed: service %q not found: %w", serviceName, err)
	}
	defer s.Close()

	st, err := s.Query()
	if err != nil {
		return fmt.Errorf("status failed: query service: %w", err)
	}

	states := map[svc.State]string{
		svc.Stopped:         "Stopped",
		svc.StartPending:    "StartPending",
		svc.StopPending:     "StopPending",
		svc.Running:         "Running",
		svc.ContinuePending: "ContinuePending",
		svc.PausePending:    "PausePending",
		svc.Paused:          "Paused",
	}
	state, ok := states[st.State]
	if !ok {
		state = fmt.Sprintf("Unknown(%d)", st.State)
	}

	fmt.Printf("Service %q: %s\n", serviceName, state)
	return nil
}

func isWindowsService() (bool, error) {
	return svc.IsWindowsService()
}

func filepathBase(path string) string {
	if path == "" {
		return serviceName
	}
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '\\' || path[i] == '/' {
			return path[i+1:]
		}
	}
	return path
}
