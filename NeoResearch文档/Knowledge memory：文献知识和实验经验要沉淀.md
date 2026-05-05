## Knowledge memory：文献知识和实验经验要沉淀

NeoResearch 不应每次从零开始。Runtime 应该把 Literature Search Agent、DataDiagnoser Agent、Reflector Agent 的知识沉淀下来。

例如：

```
某类数据适合哪些模型
某类失败通常如何修复
某类领域任务常见评价指标
某类时序数据常见周期结构
某个模型在哪些场景表现稳定
```

这可以形成：

```
knowledge_base/
├── paper_cards/
├── dataset_cards/
├── model_cards/
├── experiment_lessons/
└── failure_cases/
```

这样 NeoResearch 会逐步从“单次任务执行器”变成“持续成长的研究智能体”。