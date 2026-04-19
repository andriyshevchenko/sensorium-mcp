using Xunit;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Tests;

public class ConfigBindingTests
{
    [Fact]
    public void DefaultOptions_HaveExpectedValues()
    {
        var opts = new SupervisorOptions();

        Assert.Equal("development", opts.UpdateMode);
        Assert.Equal(4, opts.PollAtHour);
        Assert.Equal(TimeSpan.FromSeconds(60), opts.PollInterval);
        Assert.Equal(TimeSpan.FromSeconds(600), opts.MinUptime);
        Assert.Equal("npx -y sensorium-mcp@latest", opts.McpStartCommand);
        Assert.Equal(3, opts.HealthFailThresh);
        Assert.Equal(TimeSpan.FromMinutes(2), opts.McpReadyTimeout);
    }

    [Theory]
    [InlineData("development", 10)]
    [InlineData("production", 300)]
    public void GracePeriod_DefaultsByMode(string mode, int expectedSeconds)
    {
        var opts = new SupervisorOptions { UpdateMode = mode };
        int graceDef = opts.UpdateMode == "development" ? 10 : 300;

        Assert.Equal(expectedSeconds, graceDef);
    }

    [Fact]
    public void DerivedPaths_ComputedCorrectly()
    {
        string dataDir = Path.Combine(Path.GetTempPath(), "test-remote-copilot-mcp-" + Guid.NewGuid());
        string bin = Path.Combine(dataDir, "bin");
        string logs = Path.Combine(dataDir, "logs");

        var paths = new SupervisorPaths
        {
            BinaryDir = bin,
            PendingBinary = Path.Combine(bin, "sensorium-supervisor.new.exe"),
            PendingVersion = Path.Combine(bin, "sensorium-supervisor.new.exe.version"),
            ApplyFailureMarker = Path.Combine(bin, "sensorium-supervisor.new.exe.failed"),
            McpStderrLog = Path.Combine(logs, "mcp", "mcp-stderr.log"),
            SupervisorLog = Path.Combine(logs, "supervisor", "supervisor-.log"),
            ServerPid = Path.Combine(dataDir, "server.pid"),
            SupervisorLock = Path.Combine(dataDir, "supervisor.lock"),
            UpdateState = Path.Combine(dataDir, "update-state.json"),
            UpdateApplyLock = Path.Combine(dataDir, "update-apply.lock"),
            SupervisorVersion = Path.Combine(dataDir, "supervisor-version.txt"),
        };

        Assert.Equal(bin, paths.BinaryDir);
        Assert.EndsWith("mcp-stderr.log", paths.McpStderrLog);
        Assert.EndsWith("server.pid", paths.ServerPid);
        Assert.EndsWith("supervisor.lock", paths.SupervisorLock);
        Assert.EndsWith("update-state.json", paths.UpdateState);
    }
}
