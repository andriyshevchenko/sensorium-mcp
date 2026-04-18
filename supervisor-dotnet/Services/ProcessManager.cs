using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Sensorium.Supervisor.Configuration;
using Sensorium.Supervisor.Infrastructure;

namespace Sensorium.Supervisor.Services;

public sealed class ProcessManager : IProcessManager
{
    private readonly SupervisorOptions _opts;
    private readonly ILogger<ProcessManager> _log;

    private static readonly JsonSerializerOptions _jsonOpts = new() { PropertyNameCaseInsensitive = true };

    public ProcessManager(IOptions<SupervisorOptions> opts, ILogger<ProcessManager> log)
    {
        _opts = opts.Value;
        _log = log;
    }

    public async Task<int> SpawnMcpServerAsync(CancellationToken ct = default)
    {
        var cmd = _opts.McpStartCommand;
        if (string.IsNullOrWhiteSpace(cmd))
            throw new InvalidOperationException("MCP_START_COMMAND is empty");

        Directory.CreateDirectory(Path.GetDirectoryName(_opts.Paths.McpStderrLog)!);

        // Build environment: inherit all parent env vars (secrets injected by securevault),
        // then override/add the specific vars the MCP server needs.
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry kv in System.Environment.GetEnvironmentVariables())
            env[(string)kv.Key!] = (string?)kv.Value ?? "";

        if (_opts.McpHttpPort > 0)
            env["MCP_HTTP_PORT"] = _opts.McpHttpPort.ToString();
        if (!string.IsNullOrEmpty(_opts.McpHttpSecret))
            env["MCP_HTTP_SECRET"] = _opts.McpHttpSecret;
        if (!string.IsNullOrEmpty(_opts.TelegramToken))
            env["TELEGRAM_TOKEN"] = _opts.TelegramToken;
        if (!string.IsNullOrEmpty(_opts.TelegramChatId))
            env["TELEGRAM_CHAT_ID"] = _opts.TelegramChatId;

        _log.LogInformation("Starting MCP server: {Command}", cmd);
        _log.LogInformation("Capturing MCP stderr to {LogPath}", _opts.Paths.McpStderrLog);

        int pid;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            pid = SpawnWindows(cmd, env);
        else
            pid = SpawnUnix(cmd, env);

        _log.LogInformation("MCP server started with PID {Pid}", pid);
        await WritePidFileAsync(_opts.Paths.ServerPid, pid).ConfigureAwait(false);
        return pid;
    }

    // ── Windows spawn ──────────────────────────────────────────────────────────

    private int SpawnWindows(string commandLine, Dictionary<string, string> env)
    {
        var envBlock = NativeMethods.BuildEnvironmentBlock(env);

        var si = new NativeMethods.STARTUPINFO
        {
            cb = (uint)Marshal.SizeOf<NativeMethods.STARTUPINFO>(),
            dwFlags = NativeMethods.STARTF_USESTDHANDLES,
            hStdInput = IntPtr.Zero,
            hStdOutput = IntPtr.Zero
        };

        // Open stderr log file (append)
        var sa = new NativeMethods.SECURITY_ATTRIBUTES
        {
            nLength = (uint)Marshal.SizeOf<NativeMethods.SECURITY_ATTRIBUTES>(),
            bInheritHandle = true,
            lpSecurityDescriptor = IntPtr.Zero
        };

        IntPtr hStderr = NativeMethods.CreateFile(
            _opts.Paths.McpStderrLog,
            NativeMethods.FILE_APPEND_DATA,
            NativeMethods.FILE_SHARE_READ | NativeMethods.FILE_SHARE_WRITE,
            ref sa,
            NativeMethods.OPEN_ALWAYS,
            NativeMethods.FILE_ATTRIBUTE_NORMAL | NativeMethods.FILE_FLAG_WRITE_THROUGH,
            IntPtr.Zero);

        if (hStderr == NativeMethods.INVALID_HANDLE_VALUE)
        {
            int err = Marshal.GetLastWin32Error();
            _log.LogWarning("Could not open MCP stderr log (error {Error}); stderr will be discarded", err);
            si.hStdError = IntPtr.Zero;
        }
        else
        {
            si.hStdError = hStderr;
        }

        uint creationFlags =
            NativeMethods.CREATE_NEW_PROCESS_GROUP |
            NativeMethods.CREATE_BREAKAWAY_FROM_JOB |
            NativeMethods.CREATE_NO_WINDOW |
            NativeMethods.CREATE_UNICODE_ENVIRONMENT;

        var cmdLineSb = new StringBuilder(commandLine);
        NativeMethods.PROCESS_INFORMATION pi;

        GCHandle envHandle = GCHandle.Alloc(envBlock, GCHandleType.Pinned);
        try
        {
            bool ok = NativeMethods.CreateProcess(
                null,
                cmdLineSb,
                IntPtr.Zero,
                IntPtr.Zero,
                bInheritHandles: hStderr != NativeMethods.INVALID_HANDLE_VALUE,
                creationFlags,
                envHandle.AddrOfPinnedObject(),
                null,
                ref si,
                out pi);

            if (!ok)
            {
                int err = Marshal.GetLastWin32Error();
                string msg = err == 5
                    ? $"CreateProcess failed with ERROR_ACCESS_DENIED ({err}). " +
                      "The supervisor's Job Object may not have JOB_OBJECT_LIMIT_BREAKAWAY_OK. " +
                      "Check your launcher or run outside a restricted job object."
                    : $"CreateProcess failed with Win32 error {err}";
                throw new InvalidOperationException(msg);
            }
        }
        finally
        {
            envHandle.Free();
            if (hStderr != NativeMethods.INVALID_HANDLE_VALUE && hStderr != IntPtr.Zero)
                NativeMethods.CloseHandle(hStderr);
        }

        int pid = (int)pi.dwProcessId;
        NativeMethods.CloseHandle(pi.hProcess);
        NativeMethods.CloseHandle(pi.hThread);
        return pid;
    }

    // ── Unix spawn ─────────────────────────────────────────────────────────────

    private int SpawnUnix(string commandLine, Dictionary<string, string> env)
    {
        var parts = ParseCommandLine(commandLine);
        var psi = new ProcessStartInfo(parts[0])
        {
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardInput = false,
            RedirectStandardError = true
        };

        foreach (var arg in parts.Skip(1))
            psi.ArgumentList.Add(arg);

        foreach (var (k, v) in env)
            psi.Environment[k] = v;

        var proc = new System.Diagnostics.Process { StartInfo = psi };

        var stderrFile = new StreamWriter(_opts.Paths.McpStderrLog, append: true);
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null) stderrFile.WriteLine(e.Data);
        };

        proc.Start();
        proc.BeginErrorReadLine();

        // Detach — don't wait
        Task.Run(() =>
        {
            proc.WaitForExit();
            stderrFile.Flush();
            stderrFile.Dispose();
            proc.Dispose();
        });

        return proc.Id;
    }

    // ── Kill operations ────────────────────────────────────────────────────────

    public async Task KillProcessDirectAsync(int pid)
    {
        if (!IsProcessAlive(pid))
        {
            _log.LogDebug("KillProcessDirect: PID {Pid} already dead", pid);
            return;
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var result = await RunCommandAsync("taskkill", $"/F /PID {pid}").ConfigureAwait(false);
            if (result.ExitCode != 0)
                _log.LogWarning("taskkill /F /PID {Pid} failed: {Output}", pid, result.Output);
        }
        else
        {
            try
            {
                using var proc = System.Diagnostics.Process.GetProcessById(pid);
                proc.Kill(entireProcessTree: false);
            }
            catch (Exception ex)
            {
                _log.LogDebug(ex, "KillProcessDirect: PID {Pid}", pid);
            }
        }
    }

    public async Task KillProcessAsync(int pid)
    {
        if (!IsProcessAlive(pid))
        {
            _log.LogDebug("KillProcess: PID {Pid} already dead", pid);
            return;
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var result = await RunCommandAsync("taskkill", $"/F /T /PID {pid}").ConfigureAwait(false);
            if (result.ExitCode != 0)
                _log.LogWarning("taskkill /F /T /PID {Pid} failed: {Output}", pid, result.Output);
            else
                _log.LogInformation("Killed process tree PID {Pid}", pid);
        }
        else
        {
            try
            {
                using var proc = System.Diagnostics.Process.GetProcessById(pid);
                proc.Kill(entireProcessTree: false); // SIGTERM not directly available; use POSIX APIs via Kill
                await Task.Delay(2000).ConfigureAwait(false);
                if (IsProcessAlive(pid))
                {
                    proc.Kill(entireProcessTree: true);
                    _log.LogInformation("Force-killed PID {Pid}", pid);
                }
                else
                {
                    _log.LogInformation("Process PID {Pid} terminated", pid);
                }
            }
            catch (Exception ex)
            {
                _log.LogDebug(ex, "KillProcess: PID {Pid}", pid);
            }
        }
    }

    public async Task KillByPortAsync(int port)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || port <= 0 || port > 65535)
            return;

        _log.LogDebug("KillByPort: checking for processes on port {Port}", port);

        var result = await RunCommandAsync("cmd", $"/c netstat -aon | findstr \":{port}.*LISTENING\"").ConfigureAwait(false);
        if (result.ExitCode != 0 || string.IsNullOrWhiteSpace(result.Output))
        {
            _log.LogDebug("KillByPort: no listeners on port {Port}", port);
            return;
        }

        foreach (var line in result.Output.Split('\n'))
        {
            var fields = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length >= 5 && int.TryParse(fields[^1], out int pid) && pid > 0)
            {
                _log.LogInformation("Found orphan PID {Pid} on port {Port} — killing", pid, port);
                await KillProcessAsync(pid).ConfigureAwait(false);
            }
        }
    }

    public bool IsProcessAlive(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            using var proc = System.Diagnostics.Process.GetProcessById(pid);
            return !proc.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch
        {
            return false;
        }
    }

    // ── PID file helpers ───────────────────────────────────────────────────────

    public async Task<(bool ok, int pid)> ReadPidFileAsync(string path)
    {
        try
        {
            var raw = (await File.ReadAllTextAsync(path).ConfigureAwait(false)).Trim();

            // Try JSON {"pid":123}
            try
            {
                var doc = JsonDocument.Parse(raw);
                if (doc.RootElement.TryGetProperty("pid", out var pidEl) && pidEl.TryGetInt32(out int jsonPid) && jsonPid > 0)
                    return (true, jsonPid);
            }
            catch { /* not JSON, try raw int */ }

            if (int.TryParse(raw, out int rawPid) && rawPid > 0)
                return (true, rawPid);

            return (false, 0);
        }
        catch
        {
            return (false, 0);
        }
    }

    public async Task WritePidFileAsync(string path, int pid)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var json = JsonSerializer.Serialize(new { pid });
            var tmp = path + ".tmp." + System.Environment.ProcessId;
            await File.WriteAllTextAsync(tmp, json).ConfigureAwait(false);
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to write PID file {Path}", path);
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private static async Task<(int ExitCode, string Output)> RunCommandAsync(string exe, string args)
    {
        var psi = new ProcessStartInfo(exe, args)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using var proc = System.Diagnostics.Process.Start(psi)!;
        string output = await proc.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
        string err = await proc.StandardError.ReadToEndAsync().ConfigureAwait(false);
        await proc.WaitForExitAsync().ConfigureAwait(false);
        return (proc.ExitCode, output + err);
    }

    private static List<string> ParseCommandLine(string commandLine)
    {
        var parts = new List<string>();
        var current = new StringBuilder();
        bool inQuote = false;

        foreach (char c in commandLine)
        {
            if (c == '"')
            {
                inQuote = !inQuote;
            }
            else if (c == ' ' && !inQuote)
            {
                if (current.Length > 0)
                {
                    parts.Add(current.ToString());
                    current.Clear();
                }
            }
            else
            {
                current.Append(c);
            }
        }
        if (current.Length > 0)
            parts.Add(current.ToString());

        return parts.Count > 0 ? parts : ["sh", "-c", commandLine];
    }
}
