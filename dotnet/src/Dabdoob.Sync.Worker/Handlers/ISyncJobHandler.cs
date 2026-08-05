using Dabdoob.Sync.Domain.Jobs;

namespace Dabdoob.Sync.Worker.Handlers;

public interface ISyncJobHandler
{
    SyncJobType JobType { get; }

    Task HandleAsync(SyncJob job, CancellationToken cancellationToken);
}
