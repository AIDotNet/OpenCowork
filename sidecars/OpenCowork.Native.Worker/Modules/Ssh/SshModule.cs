internal sealed class SshModule : IWorkerModule
{
    public string Name => "ssh";

    public void Register(WorkerModuleContext context)
    {
        context.Register("ssh/exec", SshTools.ExecAsync);
        context.Register("ssh/test-connection", SshTools.TestConnectionAsync);
        context.Register("ssh/config-snapshot", SshConfigStore.Snapshot);
        context.Register("ssh/config-write-snapshot", SshConfigStore.WriteSnapshot);
        context.Register("ssh/config-groups-list", SshConfigStore.ListGroups);
        context.Register("ssh/config-group-create", SshConfigStore.CreateGroup);
        context.Register("ssh/config-group-update", SshConfigStore.UpdateGroup);
        context.Register("ssh/config-group-delete", SshConfigStore.DeleteGroup);
        context.Register("ssh/config-connections-list", SshConfigStore.ListConnections);
        context.Register("ssh/config-connection-get", SshConfigStore.GetConnection);
        context.Register("ssh/config-connection-create", SshConfigStore.CreateConnection);
        context.Register("ssh/config-connection-update", SshConfigStore.UpdateConnection);
        context.Register("ssh/config-connection-delete", SshConfigStore.DeleteConnection);
        context.Register("ssh/config-openssh-host", SshConfigStore.OpenSshHost);
        context.Register("ssh/config-export", SshConfigTransfer.Export);
        context.Register("ssh/import-preview", SshConfigTransfer.PreviewImport);
        context.Register("ssh/import-apply", SshConfigTransfer.ApplyImport);
        context.Register("ssh/fs-download", SshTools.DownloadAsync);
        context.Register("ssh/fs-download-abort", SshTools.AbortDownload);
        context.Register("ssh/fs-upload-file", SshTools.UploadFileAsync);
        context.Register("ssh/fs-upload-directory", SshDirectoryUploadTools.UploadDirectoryAsync);
        context.Register("ssh/fs-upload-abort", SshTools.AbortUpload);
        context.Register("ssh/fs-remote-copy-file", SshRemoteCopyTools.CopyFileAsync);
        context.Register("ssh/fs-remote-copy-abort", SshRemoteCopyTools.Abort);
        context.Register("ssh/fs-home-dir", SshFileTools.HomeDirAsync);
        context.Register("ssh/fs-resolve-path", SshFileTools.ResolvePathAsync);
        context.Register("ssh/fs-stat-path", SshFileTools.StatPathAsync);
        context.Register("ssh/fs-read-file", SshFileTools.ReadFileAsync);
        context.Register("ssh/fs-read-text-file-lines", SshFileTools.ReadTextFileLinesAsync);
        context.Register("ssh/fs-write-file", SshFileTools.WriteFileAsync);
        context.Register("ssh/fs-read-file-binary", SshFileTools.ReadFileBinaryAsync);
        context.Register("ssh/fs-write-file-binary", SshFileTools.WriteFileBinaryAsync);
        context.Register("ssh/fs-list-dir", SshFileTools.ListDirAsync);
        context.Register("ssh/fs-mkdir", SshFileTools.MkdirAsync);
        context.Register("ssh/fs-delete", SshFileTools.DeleteAsync);
        context.Register("ssh/fs-move", SshFileTools.MoveAsync);
        context.Register("ssh/fs-transfer-scan", SshTransferScanTools.ScanAsync);
        context.Register("ssh/fs-transfer-upload", SshTransferUploadTools.UploadAsync);
        context.Register("ssh/fs-transfer-download", SshTransferDownloadTools.DownloadAsync);
        context.Register("ssh/fs-transfer-remote-copy", SshTransferRemoteCopyTools.CopyAsync);
        context.Register("ssh/fs-glob", SshSearchTools.GlobAsync);
        context.Register("ssh/fs-grep", SshSearchTools.GrepAsync);
    }
}
