using Xunit;
using Sensorium.Supervisor.Configuration;

namespace Sensorium.Supervisor.Tests;

public class ConfigBindingTests
{
    [Fact]
    public void DefaultOptions_HaveExpectedValues()
    {
        var opts = new SupervisorOptions();

        Assert.Equal("npx -y sensorium-mcp@latest", opts.McpStartCommand);
        Assert.Equal(5, opts.HealthFailThresh);
        Assert.Equal(TimeSpan.FromMinutes(5), opts.McpReadyTimeout);
    }

    [Fact]
    public void DerivedPaths_ComputedCorrectly()
    {
        string dataDir = Path.Combine(Path.GetTempPath(), "test-remote-copilot-mcp-" + Guid.NewGuid());
        string logs = Path.Combine(dataDir, "logs");

        var paths = new SupervisorPaths
        {
            McpStderrLog = Path.Combine(logs, "mcp", "mcp-stderr.log"),
            SupervisorLog = Path.Combine(logs, "supervisor", "supervisor-.log"),
            ServerPid = Path.Combine(dataDir, "server.pid"),
            SupervisorLock = Path.Combine(dataDir, "supervisor.lock"),
            PollerLock = Path.Combine(dataDir, "poller.lock"),
        };

        Assert.EndsWith("mcp-stderr.log", paths.McpStderrLog);
        Assert.EndsWith("server.pid", paths.ServerPid);
        Assert.EndsWith("supervisor.lock", paths.SupervisorLock);
        Assert.EndsWith("poller.lock", paths.PollerLock);
    }
}
