import {
  DisplayElement,
  DisplayElementSchema,
  StyleSchema,
} from "@/../../packages/internal/src";
import { z } from "zod";
import { PrismaClient, prisma } from "~/db.server";

type RunOptions = {
  id: string;
  userId: string;
};

export type Task = NonNullable<
  Awaited<ReturnType<RunPresenter["call"]>>
>["tasks"][number];
export type Event = NonNullable<
  Awaited<ReturnType<RunPresenter["call"]>>
>["event"];

const ElementsSchema = z.array(DisplayElementSchema);

const taskSelect = {
  id: true,
  displayKey: true,
  runConnectionId: true,
  name: true,
  icon: true,
  status: true,
  delayUntil: true,
  noop: true,
  description: true,
  elements: true,
  params: true,
  output: true,
  error: true,
  startedAt: true,
  completedAt: true,
  style: true,
} as const;

export class RunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ id, userId }: RunOptions) {
    const run = await this.#prismaClient.jobRun.findFirst({
      select: {
        id: true,
        number: true,
        status: true,
        startedAt: true,
        completedAt: true,
        isTest: true,
        elements: true,
        version: {
          select: {
            version: true,
            elements: true,
          },
        },
        environment: {
          select: {
            type: true,
            slug: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            payload: true,
            timestamp: true,
            deliveredAt: true,
          },
        },
        tasks: {
          select: {
            ...taskSelect,
            children: {
              select: {
                ...taskSelect,
                children: {
                  select: {
                    ...taskSelect,
                    children: {
                      select: {
                        ...taskSelect,
                        children: {
                          select: {
                            ...taskSelect,
                            children: {
                              select: {
                                ...taskSelect,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
        runConnections: {
          select: {
            id: true,
            key: true,
            apiConnection: {
              select: {
                metadata: true,
                connectionType: true,
                client: {
                  select: {
                    title: true,
                    slug: true,
                    description: true,
                    scopes: true,
                    integrationIdentifier: true,
                    integrationAuthMethod: true,
                  },
                },
              },
            },
          },
        },
        missingConnections: true,
      },
      where: {
        id,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!run) {
      return undefined;
    }

    //merge the elements from the version and the run, with the run elements taking precedence
    const mergedElements = new Map<string, DisplayElement>();
    console.log("run.version.elements", run.version.elements);
    if (run.version.elements) {
      const elements = ElementsSchema.parse(run.version.elements);
      for (const element of elements) {
        mergedElements.set(element.label, element);
      }
    }
    console.log("run.elements", run.elements);
    if (run.elements) {
      const elements = ElementsSchema.parse(run.elements);
      for (const element of elements) {
        mergedElements.set(element.label, element);
      }
    }

    return {
      id: run.id,
      number: run.number,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      isTest: run.isTest,
      version: run.version.version,
      elements: Array.from(mergedElements.values()),
      environment: {
        type: run.environment.type,
        slug: run.environment.slug,
      },
      event: run.event,
      tasks: run.tasks.map((task) => ({
        ...task,
        params: task.params as Record<string, any>,
        elements:
          task.elements == null
            ? []
            : z.array(DisplayElementSchema).parse(task.elements),
        connection: run.runConnections.find(
          (c) => c.id === task.runConnectionId
        ),
        style: task.style ? StyleSchema.parse(task.style) : undefined,
      })),
      runConnections: run.runConnections,
      missingConnections: run.missingConnections,
    };
  }
}
