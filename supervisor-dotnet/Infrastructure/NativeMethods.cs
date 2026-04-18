using System.Runtime.InteropServices;
using System.Text;

namespace Sensorium.Supervisor.Infrastructure;

/// <summary>
/// P/Invoke declarations for Windows CreateProcess with job-breakaway flags.
/// Used only on Windows to spawn the MCP process outside the supervisor's Job Object.
/// </summary>
internal static class NativeMethods
{
    // Creation flags
    public const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    public const uint STARTF_USESTDHANDLES = 0x00000100;

    public static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public uint cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public uint nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(
        string? lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        ref SECURITY_ATTRIBUTES lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_APPEND_DATA = 0x00000004;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint OPEN_ALWAYS = 4;
    public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    public const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;

    /// <summary>
    /// Builds a Unicode environment block for CreateProcess from a dictionary of env vars.
    /// Format: KEY=VALUE\0KEY=VALUE\0\0 (UTF-16LE).
    /// </summary>
    public static byte[] BuildEnvironmentBlock(IDictionary<string, string> env)
    {
        var sb = new StringBuilder();
        foreach (var (key, value) in env)
        {
            sb.Append(key).Append('=').Append(value).Append('\0');
        }
        sb.Append('\0');
        return Encoding.Unicode.GetBytes(sb.ToString());
    }

    // ── Unix signal helpers ────────────────────────────────────────────────────

    public const int SIGTERM = 15;
    public const int SIGKILL = 9;

    /// <summary>
    /// POSIX kill(2): send signal <paramref name="sig"/> to process <paramref name="pid"/>.
    /// Returns 0 on success, -1 on error (errno set).  Used on non-Windows platforms only.
    /// </summary>
    [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
    public static extern int UnixKill(int pid, int sig);
}
