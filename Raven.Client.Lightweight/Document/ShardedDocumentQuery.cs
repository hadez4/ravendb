﻿//-----------------------------------------------------------------------
// <copyright file="ShardedDocumentQuery.cs" company="Hibernating Rhinos LTD">
//     Copyright (c) Hibernating Rhinos LTD. All rights reserved.
// </copyright>
//-----------------------------------------------------------------------
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Raven.Abstractions.Data;
using System.Threading;
#if !NET_3_5
using System.Threading.Tasks;
#endif
using Raven.Client.Document.SessionOperations;
using Raven.Client.Listeners;
using Raven.Client.Connection;
using Raven.Client.Shard;
using Raven.Client.Shard.ShardResolution;

#if !SILVERLIGHT
namespace Raven.Client.Document
{
	/// <summary>
	/// A query that is executed against sharded instances
	/// </summary>
	public class ShardedDocumentQuery<T> : DocumentQuery<T>
	{
		private readonly Func<ShardRequestData, IList<Tuple<string, IDatabaseCommands>>> getShardsToOperateOn;
		private readonly ShardStrategy shardStrategy;
		private List<QueryOperation> shardQueryOperations;
		private IList<IDatabaseCommands> databaseCommands;
		private IndexQuery indexQuery;
		private List<string> shardIds;

		/// <summary>
		/// Initializes a new instance of the <see cref="ShardedDocumentQuery{T}"/> class.
		/// </summary>
		public ShardedDocumentQuery(InMemoryDocumentSessionOperations session, Func<ShardRequestData, IList<Tuple<string, IDatabaseCommands>>> getShardsToOperateOn, ShardStrategy shardStrategy, string indexName, string[] projectionFields, IDocumentQueryListener[] queryListeners)
			: base(session
#if !SILVERLIGHT
			, null
#endif
#if !NET_3_5
			, null
#endif
			, indexName, projectionFields, queryListeners)
		{
			this.getShardsToOperateOn = getShardsToOperateOn;
			this.shardStrategy = shardStrategy;
		}

		protected override void InitSync()
		{
			if (queryOperation != null)
				return;

			shardQueryOperations = new List<QueryOperation>();
			theSession.IncrementRequestCount();

			ExecuteBeforeQueryListeners();

			indexQuery = GenerateIndexQuery(theQueryText.ToString());

			var shardsToOperateOn = getShardsToOperateOn(new ShardRequestData {EntityType = typeof (T), Query = indexQuery});
			databaseCommands = shardsToOperateOn.Select(x=>x.Item2).ToList();
			shardIds = shardsToOperateOn.Select(x => x.Item1).ToList();
			foreach (var dbCmd in databaseCommands)
			{
				ClearSortHints(dbCmd);
				shardQueryOperations.Add(InitializeQueryOperation(dbCmd.OperationsHeaders.Add));
			}

			ExecuteActualQuery();
		}

		public override IDocumentQuery<TProjection> SelectFields<TProjection>(string[] fields)
		{
			var documentQuery = new ShardedDocumentQuery<TProjection>(theSession,
				getShardsToOperateOn,
				shardStrategy, 
				indexName,
				fields,
				queryListeners)
			{
				pageSize = pageSize,
				theQueryText = new StringBuilder(theQueryText.ToString()),
				start = start,
				timeout = timeout,
				cutoff = cutoff,
				queryStats = queryStats,
				theWaitForNonStaleResults = theWaitForNonStaleResults,
				sortByHints = sortByHints,
				orderByFields = orderByFields,
				groupByFields = groupByFields,
				aggregationOp = aggregationOp,
				includes = new HashSet<string>(includes)
			};
			documentQuery.AfterQueryExecuted(afterQueryExecutedCallback);
			return documentQuery;
		}

		protected override void ExecuteActualQuery()
		{
			var results = new bool[databaseCommands.Count];
			while (true)
			{
				var currentCopy = results;
				results = shardStrategy.ShardAccessStrategy.Apply(databaseCommands, (dbCmd, i) =>
				{
					if (currentCopy[i]) // if we already got a good result here, do nothing
						return true;
					
					var queryOp = shardQueryOperations[i];

					using (queryOp.EnterQueryContext())
					{
						queryOp.LogQuery();
						var result = dbCmd.Query(indexName, queryOp.IndexQuery, includes.ToArray());
						return queryOp.IsAcceptable(result);
					}
				});
				if (results.All(acceptable => acceptable))
					break;
				Thread.Sleep(100);
			}

			var mergedQueryResult = shardStrategy.MergeQueryResults(indexQuery, shardQueryOperations.Select(x => x.CurrentQueryResults).ToList(), shardIds);

			shardQueryOperations[0].ForceResult(mergedQueryResult);
			queryOperation = shardQueryOperations[0];
		}
		
#if !NET_3_5
		protected override Task<QueryOperation> ExecuteActualQueryAsync()
		{
			throw new NotSupportedException();
		}
#endif
	}
}
#endif