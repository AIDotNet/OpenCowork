using System.Text;
using Xunit;

// M7-W1 CUDA launch normalization (CodeGraphCppExtractor.NormalizeCudaKernelLaunches).
// `.cu`/`.cuh` files parse with the C++ grammar, which can't read
// `kernel<<<grid, block>>>(args)` — the pre-parse space-blanks the launch config so
// the statement parses as a plain call. Pins: byte length preserved, newlines kept,
// argument list untouched, template args inside the config don't end it early,
// non-CUDA paths and unterminated launches left alone.
public sealed class CodeGraphCudaPreParseTests
{
    private static string Normalize(string source, string filePath)
    {
        var bytes = Encoding.UTF8.GetBytes(source);
        var result = CodeGraphCppExtractor.NormalizeCudaKernelLaunches(bytes, filePath);
        Assert.Equal(bytes.Length, result.Length); // Decision 22: equal-length
        return Encoding.UTF8.GetString(result);
    }

    [Fact]
    public void BlanksLaunchConfig_LeavesCallParseable()
    {
        var normalized = Normalize("myKernel<<<grid, block, 0, stream>>>(a, b);", "src/x.cu");

        Assert.StartsWith("myKernel", normalized);
        Assert.EndsWith("(a, b);", normalized);
        Assert.DoesNotContain("<<<", normalized);
        Assert.DoesNotContain("grid", normalized);
    }

    [Fact]
    public void TemplateArgumentInsideConfig_DoesNotEndLaunchEarly()
    {
        var normalized = Normalize("k<<<make<int>(1), dim3(2)>>>(x);", "a.cuh");

        Assert.EndsWith("(x);", normalized);
        Assert.DoesNotContain(">>>", normalized);
        Assert.DoesNotContain("make", normalized);
    }

    [Fact]
    public void MultiLineConfig_PreservesNewlines()
    {
        var source = "k<<<dim3(1),\n    dim3(2)>>>(x);\nvoid other() {}";
        var normalized = Normalize(source, "a.cu");

        Assert.Equal(source.Count(c => c == '\n'), normalized.Count(c => c == '\n'));
        Assert.Contains("void other() {}", normalized);
    }

    [Fact]
    public void NonCudaFile_AndUnterminatedLaunch_AreUntouched()
    {
        const string cpp = "auto v = std::vector<std::vector<std::vector<int>>>{};";
        Assert.Equal(cpp, Normalize(cpp, "a.cpp"));

        const string unterminated = "k<<<dim3(1), dim3(2)(x);";
        Assert.Equal(unterminated, Normalize(unterminated, "a.cu"));
    }
}
