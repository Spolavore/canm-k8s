class MigratorOrchestrator {
    private highNodePool: string;
    private lowNodePool: string;
    
    constructor(hNodePool: string, lNodePool: string){
        this.highNodePool = hNodePool;
        this.lowNodePool = lNodePool;
    }

};


export default MigratorOrchestrator;